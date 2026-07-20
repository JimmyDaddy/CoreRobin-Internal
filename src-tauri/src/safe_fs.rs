use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundTargetKind {
    File,
    Directory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct FileIdentity {
    volume: u64,
    file: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            volume: MetadataExt::dev(metadata),
            file: MetadataExt::ino(metadata),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DeleteRoot {
    directory: Arc<Dir>,
    volume: u64,
}

impl DeleteRoot {
    pub fn open(path: &Path) -> io::Result<Self> {
        Self::open_with_owner_check(path, true)
    }

    /// Opens a root whose location has already been restricted by the caller.
    /// This exists for the macOS `/Applications` directory, which is normally
    /// owned by root even when the user may remove an application inside it.
    #[cfg(target_os = "macos")]
    pub(crate) fn open_trusted_system_root(path: &Path) -> io::Result<Self> {
        Self::open_with_owner_check(path, false)
    }

    fn open_with_owner_check(path: &Path, require_current_owner: bool) -> io::Result<Self> {
        #[cfg(not(unix))]
        let _ = require_current_owner;
        let path_metadata = fs::symlink_metadata(path)?;
        if !path_metadata.is_dir() || path_metadata.file_type().is_symlink() {
            return Err(invalid_data("cleanup root is not a no-follow directory"));
        }
        #[cfg(windows)]
        if is_windows_reparse_point(&path_metadata) {
            return Err(invalid_data("cleanup root is a Windows reparse point"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if require_current_owner && path_metadata.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "cleanup root is not owned by the current user",
                ));
            }
        }

        let directory = Dir::open_ambient_dir(path, ambient_authority())?;
        let metadata = directory.dir_metadata()?;
        if !metadata.is_dir() {
            return Err(invalid_data("cleanup root handle is not a directory"));
        }
        Ok(Self {
            volume: MetadataExt::dev(&metadata),
            directory: Arc::new(directory),
        })
    }

    pub fn bind(&self, relative_path: &Path) -> io::Result<BoundDeleteTarget> {
        let components = relative_components(relative_path)?;
        let (name, parent_components) = components
            .split_last()
            .ok_or_else(|| invalid_data("cleanup target cannot be the cleanup root"))?;
        let mut parent = self.directory.try_clone()?;
        for component in parent_components {
            let next = parent.open_dir_nofollow(component).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("cleanup path component is not a no-follow directory: {error}"),
                )
            })?;
            ensure_same_volume(&next.dir_metadata()?, self.volume)?;
            parent = next;
        }

        let entry_metadata = parent.symlink_metadata(name)?;
        if entry_metadata.file_type().is_symlink() {
            return Err(invalid_data("cleanup target is a symbolic link"));
        }
        let (kind, handle, handle_metadata) = if entry_metadata.is_dir() {
            let directory = parent.open_dir_nofollow(name)?;
            let metadata = directory.dir_metadata()?;
            (
                BoundTargetKind::Directory,
                BoundHandle::Directory(Arc::new(directory)),
                metadata,
            )
        } else if entry_metadata.is_file() {
            let file = open_regular_file(&parent, name)?;
            let metadata = file.metadata()?;
            (
                BoundTargetKind::File,
                BoundHandle::File(Arc::new(file)),
                metadata,
            )
        } else {
            return Err(invalid_data(
                "cleanup target is a special filesystem object",
            ));
        };
        ensure_same_volume(&handle_metadata, self.volume)?;
        let identity = FileIdentity::from_metadata(&handle_metadata);
        if FileIdentity::from_metadata(&entry_metadata) != identity {
            return Err(invalid_data(
                "cleanup target changed while it was being bound",
            ));
        }

        Ok(BoundDeleteTarget {
            parent: Arc::new(parent),
            name: name.clone(),
            identity,
            volume: self.volume,
            kind,
            modified_at: handle_metadata.modified().ok().map(|time| time.into_std()),
            handle: Some(handle),
        })
    }

    pub fn open_subdirectory(
        &self,
        relative_path: &Path,
        create: bool,
        private_final_directory: bool,
    ) -> io::Result<Self> {
        let components = relative_components(relative_path)?;
        let mut current = self.directory.try_clone()?;
        for component in &components {
            let entry_metadata = match current.symlink_metadata(component) {
                Ok(metadata) => metadata,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    current.create_dir(component)?;
                    current.symlink_metadata(component)?
                }
                Err(error) => return Err(error),
            };
            if entry_metadata.file_type().is_symlink() || !entry_metadata.is_dir() {
                return Err(invalid_data(
                    "cleanup destination component is not a no-follow directory",
                ));
            }
            let next = current.open_dir_nofollow(component)?;
            let metadata = next.dir_metadata()?;
            ensure_same_volume(&metadata, self.volume)?;
            if FileIdentity::from_metadata(&entry_metadata)
                != FileIdentity::from_metadata(&metadata)
            {
                return Err(invalid_data(
                    "cleanup destination changed while it was being opened",
                ));
            }
            current = next;
        }
        if private_final_directory {
            #[cfg(unix)]
            {
                let metadata = current.dir_metadata()?;
                if cap_std::fs::MetadataExt::uid(&metadata) != unsafe { libc::geteuid() } {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "cleanup destination is not owned by the current user",
                    ));
                }
                use cap_std::fs::PermissionsExt as _;
                current.set_permissions(".", cap_std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(Self {
            directory: Arc::new(current),
            volume: self.volume,
        })
    }
}

#[derive(Clone, Debug)]
pub struct SafeFileMoveRoot {
    directory: Arc<Dir>,
    volume: u64,
}

impl SafeFileMoveRoot {
    pub fn open(path: &Path) -> io::Result<Self> {
        let root = DeleteRoot::open(path)?;
        Ok(Self {
            directory: root.directory,
            volume: root.volume,
        })
    }

    pub fn ensure_directory(
        &self,
        relative_path: &Path,
        private_final_directory: bool,
    ) -> io::Result<()> {
        let directory = self.open_directory(relative_path, true)?;
        if private_final_directory {
            #[cfg(unix)]
            {
                let metadata = directory.directory.dir_metadata()?;
                if cap_std::fs::MetadataExt::uid(&metadata) != unsafe { libc::geteuid() } {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "startup storage directory is not owned by the current user",
                    ));
                }
                use cap_std::fs::PermissionsExt as _;
                directory
                    .directory
                    .set_permissions(".", cap_std::fs::Permissions::from_mode(0o700))?;
            }
            directory.verify_path()?;
        }
        Ok(())
    }

    pub fn bind_file_move(
        &self,
        source_relative_path: &Path,
        destination_relative_path: &Path,
    ) -> io::Result<BoundFileMove> {
        let (source_parent_path, source_name) = split_relative_file(source_relative_path)?;
        let (destination_parent_path, destination_name) =
            split_relative_file(destination_relative_path)?;
        let source_parent = self.open_directory(&source_parent_path, false)?;
        let destination_parent = self.open_directory(&destination_parent_path, false)?;
        source_parent.verify_path()?;
        destination_parent.verify_path()?;

        let source_entry_metadata = source_parent.directory.symlink_metadata(&source_name)?;
        if source_entry_metadata.file_type().is_symlink() || !source_entry_metadata.is_file() {
            return Err(invalid_data(
                "startup source is not a regular no-follow file",
            ));
        }
        let source_file = open_regular_file(&source_parent.directory, &source_name)?;
        let source_metadata = source_file.metadata()?;
        ensure_same_volume(&source_metadata, self.volume)?;
        let source_identity = FileIdentity::from_metadata(&source_metadata);
        if FileIdentity::from_metadata(&source_entry_metadata) != source_identity {
            return Err(invalid_data(
                "startup source changed while it was being bound",
            ));
        }
        ensure_entry_absent(&destination_parent.directory, &destination_name)?;

        Ok(BoundFileMove {
            source_parent,
            source_name,
            source_identity,
            source_file: Arc::new(source_file),
            destination_parent,
            destination_name,
        })
    }

    fn open_directory(&self, relative_path: &Path, create: bool) -> io::Result<StableDirectory> {
        let components = relative_components_allow_empty(relative_path)?;
        let mut current = self.directory.try_clone()?;
        let mut chain = Vec::with_capacity(components.len());
        for component in components {
            let entry_metadata = match current.symlink_metadata(&component) {
                Ok(metadata) => metadata,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    current.create_dir(&component)?;
                    current.symlink_metadata(&component)?
                }
                Err(error) => return Err(error),
            };
            if entry_metadata.file_type().is_symlink() || !entry_metadata.is_dir() {
                return Err(invalid_data(
                    "startup directory component is not a no-follow directory",
                ));
            }
            let next = current.open_dir_nofollow(&component)?;
            let handle_metadata = next.dir_metadata()?;
            ensure_same_volume(&handle_metadata, self.volume)?;
            let identity = FileIdentity::from_metadata(&handle_metadata);
            if FileIdentity::from_metadata(&entry_metadata) != identity {
                return Err(invalid_data(
                    "startup directory changed while it was being opened",
                ));
            }
            chain.push(DirectoryStep {
                parent: Arc::new(current.try_clone()?),
                name: component,
                identity,
            });
            current = next;
        }
        Ok(StableDirectory {
            directory: Arc::new(current),
            chain: Arc::new(chain),
        })
    }
}

#[derive(Clone, Debug)]
struct DirectoryStep {
    parent: Arc<Dir>,
    name: OsString,
    identity: FileIdentity,
}

#[derive(Clone, Debug)]
struct StableDirectory {
    directory: Arc<Dir>,
    chain: Arc<Vec<DirectoryStep>>,
}

impl StableDirectory {
    fn verify_path(&self) -> io::Result<()> {
        for step in self.chain.iter() {
            verify_entry_identity(&step.parent, &step.name, step.identity)?;
        }
        if let Some(last) = self.chain.last()
            && FileIdentity::from_metadata(&self.directory.dir_metadata()?) != last.identity
        {
            return Err(invalid_data("startup directory handle identity changed"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct SafeFileSnapshot {
    pub length: u64,
    pub modified_at: Option<SystemTime>,
    pub contents: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct BoundFileMove {
    source_parent: StableDirectory,
    source_name: OsString,
    source_identity: FileIdentity,
    source_file: Arc<File>,
    destination_parent: StableDirectory,
    destination_name: OsString,
}

impl BoundFileMove {
    pub fn source_snapshot(&self, maximum_bytes: u64) -> io::Result<SafeFileSnapshot> {
        self.verify_source()?;
        let before = self.source_file.metadata()?;
        if before.len() > maximum_bytes {
            return Err(invalid_data("startup source exceeds the allowed size"));
        }
        let mut file = self.source_file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let capacity = usize::try_from(before.len()).unwrap_or(0);
        let mut contents = Vec::with_capacity(capacity);
        Read::by_ref(&mut file)
            .take(maximum_bytes.saturating_add(1))
            .read_to_end(&mut contents)?;
        if u64::try_from(contents.len()).unwrap_or(u64::MAX) > maximum_bytes {
            return Err(invalid_data("startup source exceeds the allowed size"));
        }
        let after = self.source_file.metadata()?;
        self.verify_source()?;
        if FileIdentity::from_metadata(&before) != self.source_identity
            || FileIdentity::from_metadata(&after) != self.source_identity
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
        {
            return Err(invalid_data(
                "startup source changed while it was being read",
            ));
        }
        Ok(SafeFileSnapshot {
            length: after.len(),
            modified_at: after.modified().ok().map(|time| time.into_std()),
            contents,
        })
    }

    pub fn execute(self) -> io::Result<()> {
        self.execute_with_hook(|| {})
    }

    fn execute_with_hook(self, after_link: impl FnOnce()) -> io::Result<()> {
        self.source_parent.verify_path()?;
        self.destination_parent.verify_path()?;
        self.verify_source()?;
        ensure_entry_absent(&self.destination_parent.directory, &self.destination_name)?;

        self.source_parent.directory.hard_link(
            &self.source_name,
            &self.destination_parent.directory,
            &self.destination_name,
        )?;
        let linked_metadata = self
            .destination_parent
            .directory
            .symlink_metadata(&self.destination_name)?;
        let linked_identity = FileIdentity::from_metadata(&linked_metadata);
        if linked_metadata.file_type().is_symlink()
            || !linked_metadata.is_file()
            || linked_identity != self.source_identity
        {
            let _ = self.rollback_destination(linked_identity);
            return Err(invalid_data(
                "startup source changed while the destination link was created",
            ));
        }

        after_link();
        let before_unlink = (|| {
            self.source_parent.verify_path()?;
            self.destination_parent.verify_path()?;
            self.verify_source()?;
            verify_entry_identity(
                &self.destination_parent.directory,
                &self.destination_name,
                self.source_identity,
            )
        })();
        if let Err(error) = before_unlink {
            let _ = self.rollback_destination(self.source_identity);
            return Err(io::Error::new(
                error.kind(),
                format!("startup move stopped before source removal: {error}"),
            ));
        }

        if let Err(error) = self.source_parent.directory.remove_file(&self.source_name) {
            let rollback = self.rollback_destination(self.source_identity);
            return Err(io::Error::new(
                error.kind(),
                format!(
                    "startup source could not be removed; destination rollback result: {rollback:?}: {error}"
                ),
            ));
        }
        self.source_parent.verify_path()?;
        self.destination_parent.verify_path()?;
        verify_entry_identity(
            &self.destination_parent.directory,
            &self.destination_name,
            self.source_identity,
        )?;
        sync_directory(&self.source_parent.directory)?;
        sync_directory(&self.destination_parent.directory)
    }

    fn verify_source(&self) -> io::Result<()> {
        verify_entry_identity(
            &self.source_parent.directory,
            &self.source_name,
            self.source_identity,
        )?;
        let metadata = self.source_file.metadata()?;
        if !metadata.is_file() || FileIdentity::from_metadata(&metadata) != self.source_identity {
            return Err(invalid_data("startup source handle identity changed"));
        }
        Ok(())
    }

    fn rollback_destination(&self, expected_identity: FileIdentity) -> io::Result<()> {
        verify_entry_identity(
            &self.destination_parent.directory,
            &self.destination_name,
            expected_identity,
        )?;
        self.destination_parent
            .directory
            .remove_file(&self.destination_name)
    }
}

#[derive(Clone, Debug)]
enum BoundHandle {
    File(Arc<File>),
    Directory(Arc<Dir>),
}

#[derive(Clone, Debug)]
pub struct BoundDeleteTarget {
    parent: Arc<Dir>,
    name: OsString,
    identity: FileIdentity,
    volume: u64,
    kind: BoundTargetKind,
    modified_at: Option<SystemTime>,
    handle: Option<BoundHandle>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeInspection {
    pub logical_size_bytes: u64,
    pub allocated_size_bytes: u64,
    pub item_count: usize,
    fingerprint: [u8; 32],
}

impl BoundDeleteTarget {
    pub fn modified_at(&self) -> Option<SystemTime> {
        self.modified_at
    }

    pub fn current_modified_at(&self) -> io::Result<Option<SystemTime>> {
        Ok(self
            .current_entry_metadata()?
            .modified()
            .ok()
            .map(|time| time.into_std()))
    }

    pub fn inspect(&self) -> Result<TreeInspection, String> {
        self.inspect_with_internal_symlinks(false)
    }

    /// Inspects a verified directory without following symlinks contained in it.
    ///
    /// macOS application bundles commonly use internal symlinks for frameworks
    /// and resources. The selected bundle itself is still required to be a
    /// no-follow directory; only entries below that verified root are treated as
    /// leaf nodes and fingerprinted by their no-follow metadata.
    pub fn inspect_allowing_internal_symlinks(&self) -> Result<TreeInspection, String> {
        self.inspect_with_internal_symlinks(true)
    }

    fn inspect_with_internal_symlinks(
        &self,
        allow_internal_symlinks: bool,
    ) -> Result<TreeInspection, String> {
        self.current_entry_metadata()
            .map_err(|error| format!("Cleanup target changed before inspection: {error}"))?;
        match self.handle.as_ref().expect("bound handle is present") {
            BoundHandle::File(file) => inspect_bound_file(file, self.identity),
            BoundHandle::Directory(directory) => {
                self.inspect_directory(directory, allow_internal_symlinks)
            }
        }
    }

    pub fn move_to_directory_noreplace(
        &self,
        destination: &DeleteRoot,
        destination_name: &OsStr,
    ) -> io::Result<()> {
        if self.volume != destination.volume {
            return Err(io::Error::new(
                io::ErrorKind::CrossesDevices,
                "cleanup target and Trash are on different filesystems",
            ));
        }
        let destination_components = relative_components(Path::new(destination_name))?;
        if destination_components.len() != 1 {
            return Err(invalid_data(
                "cleanup Trash destination must be one filename component",
            ));
        }
        self.current_entry_metadata()?;
        ensure_entry_absent(&destination.directory, destination_name)?;
        rename_entry_noreplace(
            &self.parent,
            &self.name,
            &destination.directory,
            destination_name,
        )?;
        verify_entry_identity(&destination.directory, destination_name, self.identity)?;
        match self.parent.symlink_metadata(&self.name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => {
                return Err(invalid_data(
                    "cleanup target still exists after moving it to Trash",
                ));
            }
            Err(error) => return Err(error),
        }
        sync_directory(&self.parent)?;
        sync_directory(&destination.directory)
    }

    pub fn delete_cancellable(
        self,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
    ) -> Result<bool, String> {
        self.delete_cancellable_with_policy(cancelled, on_entry_deleted, false, || {})
    }

    /// Deletes symlinks contained below a verified directory as link entries,
    /// never by traversing their targets. Intended for validated application
    /// bundles; generic cleanup keeps the stricter fail-closed behavior.
    pub fn delete_cancellable_allowing_internal_symlinks(
        self,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
    ) -> Result<bool, String> {
        self.delete_cancellable_with_policy(cancelled, on_entry_deleted, true, || {})
    }

    #[cfg(test)]
    fn delete_cancellable_with_hook(
        self,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
        after_root_validation: impl FnOnce(),
    ) -> Result<bool, String> {
        self.delete_cancellable_with_policy(
            cancelled,
            on_entry_deleted,
            false,
            after_root_validation,
        )
    }

    fn delete_cancellable_with_policy(
        mut self,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
        allow_internal_symlinks: bool,
        after_root_validation: impl FnOnce(),
    ) -> Result<bool, String> {
        self.current_entry_metadata()
            .map_err(|error| format!("Cleanup target changed before deletion: {error}"))?;
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        after_root_validation();

        let handle = self
            .handle
            .take()
            .ok_or_else(|| "Cleanup target handle was already consumed.".to_owned())?;
        match handle {
            BoundHandle::File(file) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Ok(false);
                }
                self.current_entry_metadata()
                    .map_err(|error| format!("Cleanup target changed before deletion: {error}"))?;
                let metadata = file.metadata().map_err(|error| {
                    format!("Could not inspect the bound cleanup file: {error}")
                })?;
                let deleted_bytes = allocated_file_size(&metadata);
                self.parent
                    .remove_file(&self.name)
                    .map_err(|error| format!("Could not delete the bound cleanup file: {error}"))?;
                on_entry_deleted(deleted_bytes);
                Ok(true)
            }
            BoundHandle::Directory(directory) => {
                let directory = Arc::try_unwrap(directory).map_err(|_| {
                    "Cleanup directory handle is unexpectedly shared during deletion.".to_owned()
                })?;
                self.delete_directory(
                    directory,
                    cancelled,
                    on_entry_deleted,
                    allow_internal_symlinks,
                )
            }
        }
    }

    fn delete_directory(
        &self,
        root: Dir,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
        allow_internal_symlinks: bool,
    ) -> Result<bool, String> {
        let root_entries = read_entry_names(&root, Path::new("."))?;
        let mut frames = vec![DirectoryFrame {
            directory: root,
            name_in_parent: None,
            identity: self.identity,
            display_path: Path::new(".").to_path_buf(),
            entries: root_entries,
            next_entry: 0,
        }];
        let mut seen_files = HashSet::new();
        let mut completed_root = None;

        while !frames.is_empty() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(false);
            }

            let next_name = {
                let frame = frames.last_mut().expect("frame stack is not empty");
                let name = frame.entries.get(frame.next_entry).cloned();
                if name.is_some() {
                    frame.next_entry = frame.next_entry.saturating_add(1);
                }
                name
            };

            if let Some(name) = next_name {
                let frame = frames.last().expect("frame stack is not empty");
                let display_path = frame.display_path.join(&name);
                let entry_metadata = frame.directory.symlink_metadata(&name).map_err(|error| {
                    format!(
                        "Could not inspect {} during deletion: {error}",
                        display_path.display()
                    )
                })?;
                if entry_metadata.file_type().is_symlink() {
                    if !allow_internal_symlinks {
                        return Err(format!(
                            "Refused to delete {} because it is a symbolic link or reparse point.",
                            display_path.display()
                        ));
                    }
                    ensure_same_volume(&entry_metadata, self.volume)
                        .map_err(|error| error.to_string())?;
                    let identity = FileIdentity::from_metadata(&entry_metadata);
                    verify_symlink_identity(&frame.directory, &name, identity).map_err(
                        |error| {
                            format!(
                                "Refused to unlink {} because it changed: {error}",
                                display_path.display()
                            )
                        },
                    )?;
                    let deleted_bytes = allocated_file_size(&entry_metadata);
                    frame.directory.remove_file(&name).map_err(|error| {
                        format!("Could not unlink {}: {error}", display_path.display())
                    })?;
                    on_entry_deleted(deleted_bytes);
                    continue;
                }

                if entry_metadata.is_dir() {
                    let child = frame.directory.open_dir_nofollow(&name).map_err(|error| {
                        format!(
                            "Refused to open {} as a no-follow directory: {error}",
                            display_path.display()
                        )
                    })?;
                    let child_metadata = child.dir_metadata().map_err(|error| {
                        format!("Could not inspect {}: {error}", display_path.display())
                    })?;
                    ensure_same_volume(&child_metadata, self.volume)
                        .map_err(|error| error.to_string())?;
                    let child_identity = FileIdentity::from_metadata(&child_metadata);
                    if FileIdentity::from_metadata(&entry_metadata) != child_identity {
                        return Err(format!(
                            "Refused to delete {} because it changed during traversal.",
                            display_path.display()
                        ));
                    }
                    let entries = read_entry_names(&child, &display_path)?;
                    frames.push(DirectoryFrame {
                        directory: child,
                        name_in_parent: Some(name),
                        identity: child_identity,
                        display_path,
                        entries,
                        next_entry: 0,
                    });
                } else if entry_metadata.is_file() {
                    let file = open_regular_file(&frame.directory, &name).map_err(|error| {
                        format!(
                            "Refused to open {} as a no-follow file: {error}",
                            display_path.display()
                        )
                    })?;
                    let metadata = file.metadata().map_err(|error| {
                        format!("Could not inspect {}: {error}", display_path.display())
                    })?;
                    ensure_same_volume(&metadata, self.volume)
                        .map_err(|error| error.to_string())?;
                    let identity = FileIdentity::from_metadata(&metadata);
                    if FileIdentity::from_metadata(&entry_metadata) != identity {
                        return Err(format!(
                            "Refused to delete {} because it changed during traversal.",
                            display_path.display()
                        ));
                    }
                    verify_entry_identity(&frame.directory, &name, identity).map_err(|error| {
                        format!(
                            "Refused to delete {} because it changed: {error}",
                            display_path.display()
                        )
                    })?;
                    let deleted_bytes =
                        if MetadataExt::nlink(&metadata) <= 1 || seen_files.insert(identity) {
                            allocated_file_size(&metadata)
                        } else {
                            0
                        };
                    frame.directory.remove_file(&name).map_err(|error| {
                        format!("Could not delete {}: {error}", display_path.display())
                    })?;
                    on_entry_deleted(deleted_bytes);
                } else {
                    return Err(format!(
                        "Refused to delete {} because it is a special filesystem object.",
                        display_path.display()
                    ));
                }
                continue;
            }

            let completed = frames.pop().expect("frame stack is not empty");
            if let Some(name) = completed.name_in_parent {
                let parent = frames.last().expect("child frame must have a parent");
                verify_entry_identity(&parent.directory, &name, completed.identity).map_err(
                    |error| {
                        format!(
                            "Refused to remove {} because it changed: {error}",
                            completed.display_path.display()
                        )
                    },
                )?;
                completed.directory.remove_open_dir().map_err(|error| {
                    format!(
                        "Could not remove {} after deleting its contents: {error}",
                        completed.display_path.display()
                    )
                })?;
                on_entry_deleted(0);
            } else {
                completed_root = Some(completed.directory);
            }
        }

        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        verify_entry_identity(&self.parent, &self.name, self.identity)
            .map_err(|error| format!("Cleanup target changed before final removal: {error}"))?;
        completed_root
            .ok_or_else(|| "Cleanup root handle was lost during deletion.".to_owned())?
            .remove_open_dir()
            .map_err(|error| format!("Could not remove the bound cleanup directory: {error}"))?;
        on_entry_deleted(0);
        Ok(true)
    }

    fn inspect_directory(
        &self,
        root: &Dir,
        allow_internal_symlinks: bool,
    ) -> Result<TreeInspection, String> {
        let root_directory = root
            .try_clone()
            .map_err(|error| format!("Could not retain the cleanup directory: {error}"))?;
        let root_metadata = root_directory
            .dir_metadata()
            .map_err(|error| format!("Could not inspect the cleanup directory: {error}"))?;
        let root_modified_at = metadata_modified_at(&root_metadata);
        let root_entries = read_entry_names(&root_directory, Path::new("."))?;
        let mut frames = vec![InspectionFrame {
            directory: root_directory,
            name_in_parent: None,
            identity: self.identity,
            modified_at: root_modified_at,
            display_path: Path::new(".").to_path_buf(),
            entries: root_entries,
            next_entry: 0,
        }];
        let mut logical_size_bytes = 0_u64;
        let mut allocated_size_bytes = 0_u64;
        let mut item_count = 0_usize;
        let mut seen_files = HashSet::new();
        let mut fingerprint = Sha256::new();
        fingerprint.update(b"core-robin-cleanup-tree-v1");
        hash_identity(&mut fingerprint, self.identity);
        hash_modified_at(&mut fingerprint, root_modified_at);

        while !frames.is_empty() {
            let next_name = {
                let frame = frames.last_mut().expect("inspection stack is not empty");
                let name = frame.entries.get(frame.next_entry).cloned();
                if name.is_some() {
                    frame.next_entry = frame.next_entry.saturating_add(1);
                }
                name
            };
            if let Some(name) = next_name {
                let frame = frames.last().expect("inspection stack is not empty");
                let display_path = frame.display_path.join(&name);
                let entry_metadata = frame.directory.symlink_metadata(&name).map_err(|error| {
                    format!(
                        "Could not inspect {} while refreshing deletion evidence: {error}",
                        display_path.display()
                    )
                })?;
                if entry_metadata.file_type().is_symlink() {
                    if !allow_internal_symlinks {
                        return Err(format!(
                            "Refused to refresh {} because it is a symbolic link or reparse point.",
                            display_path.display()
                        ));
                    }
                    ensure_same_volume(&entry_metadata, self.volume)
                        .map_err(|error| error.to_string())?;
                    let identity = FileIdentity::from_metadata(&entry_metadata);
                    verify_symlink_identity(&frame.directory, &name, identity).map_err(
                        |error| {
                            format!(
                                "Refused to refresh {} because its link changed: {error}",
                                display_path.display()
                            )
                        },
                    )?;
                    hash_os_str(&mut fingerprint, &name);
                    fingerprint.update([b'l']);
                    hash_identity(&mut fingerprint, identity);
                    fingerprint.update(entry_metadata.len().to_le_bytes());
                    hash_modified_at(&mut fingerprint, metadata_modified_at(&entry_metadata));
                    logical_size_bytes = logical_size_bytes.saturating_add(entry_metadata.len());
                    allocated_size_bytes =
                        allocated_size_bytes.saturating_add(allocated_file_size(&entry_metadata));
                    item_count = item_count.saturating_add(1);
                    continue;
                }
                hash_os_str(&mut fingerprint, &name);

                if entry_metadata.is_dir() {
                    let child = frame.directory.open_dir_nofollow(&name).map_err(|error| {
                        format!(
                            "Refused to open {} as a no-follow directory: {error}",
                            display_path.display()
                        )
                    })?;
                    let child_metadata = child.dir_metadata().map_err(|error| {
                        format!("Could not inspect {}: {error}", display_path.display())
                    })?;
                    ensure_same_volume(&child_metadata, self.volume)
                        .map_err(|error| error.to_string())?;
                    let child_identity = FileIdentity::from_metadata(&child_metadata);
                    if FileIdentity::from_metadata(&entry_metadata) != child_identity {
                        return Err(format!(
                            "Refused to refresh {} because it changed during traversal.",
                            display_path.display()
                        ));
                    }
                    let child_modified_at = metadata_modified_at(&child_metadata);
                    fingerprint.update([b'd']);
                    hash_identity(&mut fingerprint, child_identity);
                    hash_modified_at(&mut fingerprint, child_modified_at);
                    let entries = read_entry_names(&child, &display_path)?;
                    frames.push(InspectionFrame {
                        directory: child,
                        name_in_parent: Some(name),
                        identity: child_identity,
                        modified_at: child_modified_at,
                        display_path,
                        entries,
                        next_entry: 0,
                    });
                } else if entry_metadata.is_file() {
                    let file = open_regular_file(&frame.directory, &name).map_err(|error| {
                        format!(
                            "Refused to open {} as a no-follow file: {error}",
                            display_path.display()
                        )
                    })?;
                    let metadata = file.metadata().map_err(|error| {
                        format!("Could not inspect {}: {error}", display_path.display())
                    })?;
                    ensure_same_volume(&metadata, self.volume)
                        .map_err(|error| error.to_string())?;
                    let identity = FileIdentity::from_metadata(&metadata);
                    if FileIdentity::from_metadata(&entry_metadata) != identity {
                        return Err(format!(
                            "Refused to refresh {} because it changed during traversal.",
                            display_path.display()
                        ));
                    }
                    verify_entry_identity(&frame.directory, &name, identity).map_err(|error| {
                        format!(
                            "Refused to refresh {} because it changed: {error}",
                            display_path.display()
                        )
                    })?;
                    fingerprint.update([b'f']);
                    hash_identity(&mut fingerprint, identity);
                    fingerprint.update(metadata.len().to_le_bytes());
                    hash_modified_at(&mut fingerprint, metadata_modified_at(&metadata));
                    if seen_files.insert(identity) {
                        logical_size_bytes = logical_size_bytes.saturating_add(metadata.len());
                        allocated_size_bytes =
                            allocated_size_bytes.saturating_add(allocated_file_size(&metadata));
                        item_count = item_count.saturating_add(1);
                    }
                } else {
                    return Err(format!(
                        "Refused to refresh {} because it is a special filesystem object.",
                        display_path.display()
                    ));
                }
                continue;
            }

            let completed = frames.pop().expect("inspection stack is not empty");
            let current_metadata = completed.directory.dir_metadata().map_err(|error| {
                format!(
                    "Could not revalidate {} after inspection: {error}",
                    completed.display_path.display()
                )
            })?;
            if FileIdentity::from_metadata(&current_metadata) != completed.identity
                || metadata_modified_at(&current_metadata) != completed.modified_at
            {
                return Err(format!(
                    "Cleanup directory {} changed during inspection.",
                    completed.display_path.display()
                ));
            }
            if let Some(name) = completed.name_in_parent {
                let parent = frames.last().expect("child inspection frame has a parent");
                verify_entry_identity(&parent.directory, &name, completed.identity).map_err(
                    |error| {
                        format!(
                            "Refused to finish refreshing {} because it changed: {error}",
                            completed.display_path.display()
                        )
                    },
                )?;
            }
        }
        self.current_entry_metadata()
            .map_err(|error| format!("Cleanup target changed after inspection: {error}"))?;
        let fingerprint: [u8; 32] = fingerprint.finalize().into();
        Ok(TreeInspection {
            logical_size_bytes,
            allocated_size_bytes,
            item_count,
            fingerprint,
        })
    }

    fn current_entry_metadata(&self) -> io::Result<Metadata> {
        let metadata = self.parent.symlink_metadata(&self.name)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid_data("cleanup target became a symbolic link"));
        }
        let kind_matches = match self.kind {
            BoundTargetKind::File => metadata.is_file(),
            BoundTargetKind::Directory => metadata.is_dir(),
        };
        if !kind_matches || FileIdentity::from_metadata(&metadata) != self.identity {
            return Err(invalid_data("cleanup target identity changed"));
        }
        Ok(metadata)
    }
}

#[cfg(target_os = "macos")]
fn rename_entry_noreplace(
    source: &Dir,
    source_name: &OsStr,
    destination: &Dir,
    destination_name: &OsStr,
) -> io::Result<()> {
    let source_name = CString::new(source_name.as_bytes())?;
    let destination_name = CString::new(destination_name.as_bytes())?;
    let result = unsafe {
        libc::renameatx_np(
            source.as_raw_fd(),
            source_name.as_ptr(),
            destination.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_entry_noreplace(
    source: &Dir,
    source_name: &OsStr,
    destination: &Dir,
    destination_name: &OsStr,
) -> io::Result<()> {
    let source_name = CString::new(source_name.as_bytes())?;
    let destination_name = CString::new(destination_name.as_bytes())?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source.as_raw_fd(),
            source_name.as_ptr(),
            destination.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_entry_noreplace(
    _source: &Dir,
    _source_name: &OsStr,
    _destination: &Dir,
    _destination_name: &OsStr,
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "moving cleanup items to the system Trash is not supported on this platform",
    ))
}

#[derive(Debug)]
struct DirectoryFrame {
    directory: Dir,
    name_in_parent: Option<OsString>,
    identity: FileIdentity,
    display_path: std::path::PathBuf,
    entries: Vec<OsString>,
    next_entry: usize,
}

#[derive(Debug)]
struct InspectionFrame {
    directory: Dir,
    name_in_parent: Option<OsString>,
    identity: FileIdentity,
    modified_at: Option<SystemTime>,
    display_path: PathBuf,
    entries: Vec<OsString>,
    next_entry: usize,
}

fn inspect_bound_file(file: &File, expected: FileIdentity) -> Result<TreeInspection, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect the bound cleanup file: {error}"))?;
    if !metadata.is_file() || FileIdentity::from_metadata(&metadata) != expected {
        return Err("Cleanup file identity changed during inspection.".to_owned());
    }
    let mut fingerprint = Sha256::new();
    fingerprint.update(b"core-robin-cleanup-tree-v1");
    fingerprint.update([b'f']);
    hash_identity(&mut fingerprint, expected);
    fingerprint.update(metadata.len().to_le_bytes());
    hash_modified_at(&mut fingerprint, metadata_modified_at(&metadata));
    Ok(TreeInspection {
        logical_size_bytes: metadata.len(),
        allocated_size_bytes: allocated_file_size(&metadata),
        item_count: 1,
        fingerprint: fingerprint.finalize().into(),
    })
}

fn metadata_modified_at(metadata: &Metadata) -> Option<SystemTime> {
    metadata.modified().ok().map(|time| time.into_std())
}

fn hash_identity(hasher: &mut Sha256, identity: FileIdentity) {
    hasher.update(identity.volume.to_le_bytes());
    hasher.update(identity.file.to_le_bytes());
}

fn hash_modified_at(hasher: &mut Sha256, modified_at: Option<SystemTime>) {
    let nanos = modified_at
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    hasher.update(nanos.to_le_bytes());
}

#[cfg(unix)]
fn hash_os_str(hasher: &mut Sha256, value: &OsStr) {
    use std::os::unix::ffi::OsStrExt as _;
    let bytes = value.as_bytes();
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

#[cfg(windows)]
fn hash_os_str(hasher: &mut Sha256, value: &OsStr) {
    use std::os::windows::ffi::OsStrExt as _;
    let encoded = value.encode_wide().collect::<Vec<_>>();
    hasher.update((encoded.len() as u64).to_le_bytes());
    for unit in encoded {
        hasher.update(unit.to_le_bytes());
    }
}

fn split_relative_file(path: &Path) -> io::Result<(PathBuf, OsString)> {
    let components = relative_components(path)?;
    let (name, parent_components) = components
        .split_last()
        .ok_or_else(|| invalid_data("filesystem move path cannot be empty"))?;
    let mut parent = PathBuf::new();
    for component in parent_components {
        parent.push(component);
    }
    Ok((parent, name.clone()))
}

fn relative_components_allow_empty(path: &Path) -> io::Result<Vec<OsString>> {
    if path.as_os_str().is_empty() {
        return Ok(Vec::new());
    }
    relative_components(path)
}

fn relative_components(path: &Path) -> io::Result<Vec<OsString>> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(component) => components.push(component.to_os_string()),
            _ => {
                return Err(invalid_data(
                    "cleanup target must contain only normal relative path components",
                ));
            }
        }
    }
    if components.is_empty() {
        return Err(invalid_data("cleanup target cannot be empty"));
    }
    Ok(components)
}

fn ensure_entry_absent(directory: &Dir, name: &OsStr) -> io::Result<()> {
    match directory.symlink_metadata(name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "filesystem destination already exists",
        )),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn sync_directory(directory: &Dir) -> io::Result<()> {
    use rustix::fs::{Mode, OFlags, fsync, openat};

    let handle = openat(
        directory,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    Ok(fsync(handle)?)
}

#[cfg(not(target_os = "linux"))]
fn sync_directory(directory: &Dir) -> io::Result<()> {
    let result = directory.try_clone()?.into_std_file().sync_all();
    #[cfg(windows)]
    if result
        .as_ref()
        .is_err_and(|error| error.raw_os_error() == Some(5))
    {
        return Ok(());
    }
    result
}

fn open_regular_file(directory: &Dir, name: &OsStr) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    options.follow(FollowSymlinks::No);
    let file = directory.open_with(name, &options)?;
    if !file.metadata()?.is_file() {
        return Err(invalid_data("cleanup entry is not a regular file"));
    }
    Ok(file)
}

fn read_entry_names(directory: &Dir, display_path: &Path) -> Result<Vec<OsString>, String> {
    let entries = directory.entries().map_err(|error| {
        format!(
            "Could not enumerate {} during deletion: {error}",
            display_path.display()
        )
    })?;
    let mut names = Vec::new();
    for entry in entries {
        names.push(
            entry
                .map_err(|error| {
                    format!(
                        "Could not read an entry in {}: {error}",
                        display_path.display()
                    )
                })?
                .file_name(),
        );
    }
    names.sort();
    Ok(names)
}

fn verify_entry_identity(directory: &Dir, name: &OsStr, expected: FileIdentity) -> io::Result<()> {
    let metadata = directory.symlink_metadata(name)?;
    if metadata.file_type().is_symlink() || FileIdentity::from_metadata(&metadata) != expected {
        return Err(invalid_data("filesystem entry identity changed"));
    }
    Ok(())
}

fn verify_symlink_identity(
    directory: &Dir,
    name: &OsStr,
    expected: FileIdentity,
) -> io::Result<()> {
    let metadata = directory.symlink_metadata(name)?;
    if !metadata.file_type().is_symlink() || FileIdentity::from_metadata(&metadata) != expected {
        return Err(invalid_data("symbolic link identity changed"));
    }
    Ok(())
}

fn ensure_same_volume(metadata: &Metadata, expected_volume: u64) -> io::Result<()> {
    if MetadataExt::dev(metadata) != expected_volume {
        return Err(invalid_data(
            "cleanup traversal crossed into another filesystem volume",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn allocated_file_size(metadata: &Metadata) -> u64 {
    use cap_std::fs::MetadataExt as _;
    metadata.blocks().saturating_mul(512)
}

#[cfg(windows)]
fn allocated_file_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    metadata.file_attributes() & 0x0400 != 0
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    fn test_root(suffix: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos();
        std::env::temp_dir().join(format!("core-robin-safe-fs-{suffix}-{nonce}"))
    }

    #[test]
    fn deletes_a_deep_tree_without_path_recursion() {
        let home = test_root("deep");
        let target = home.join("target");
        let mut directory = target.clone();
        for _ in 0..128 {
            directory = directory.join("d");
        }
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("leaf.bin"), b"leaf").unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();
        let mut deleted_entries = 0;
        assert!(
            bound
                .delete_cancellable(&AtomicBool::new(false), &mut |_| {
                    deleted_entries += 1;
                })
                .unwrap()
        );
        assert!(!target.exists());
        assert_eq!(deleted_entries, 130);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn parent_rename_and_symlink_swap_cannot_escape_the_bound_tree() {
        use std::os::unix::fs::symlink;

        let home = test_root("root-race");
        let target = home.join("target");
        let moved = home.join("moved-target");
        let outside = home.join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(target.join("delete.bin"), b"delete").unwrap();
        fs::write(outside.join("sentinel.bin"), b"keep").unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();

        let error = bound
            .delete_cancellable_with_hook(&AtomicBool::new(false), &mut |_| {}, || {
                fs::rename(&target, &moved).unwrap();
                symlink(&outside, &target).unwrap();
            })
            .expect_err("the final identity check must reject the replacement");
        assert!(error.contains("changed"));
        assert_eq!(fs::read(outside.join("sentinel.bin")).unwrap(), b"keep");
        assert!(moved.exists());
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);

        fs::remove_file(target).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_rename_and_symlink_swap_cannot_delete_the_replacement() {
        use std::os::unix::fs::symlink;

        let home = test_root("file-race");
        let target = home.join("target.bin");
        let moved = home.join("moved-target.bin");
        let outside = home.join("outside.bin");
        fs::create_dir_all(&home).unwrap();
        fs::write(&target, b"delete").unwrap();
        fs::write(&outside, b"keep").unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target.bin"))
            .unwrap();

        let error = bound
            .delete_cancellable_with_hook(&AtomicBool::new(false), &mut |_| {}, || {
                fs::rename(&target, &moved).unwrap();
                symlink(&outside, &target).unwrap();
            })
            .expect_err("the replacement must fail the identity check");
        assert!(error.contains("changed"));
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        assert_eq!(fs::read(&moved).unwrap(), b"delete");

        fs::remove_file(target).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn nested_symlink_is_rejected_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let home = test_root("nested-link");
        let target = home.join("target");
        let outside = home.join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("sentinel.bin"), b"keep").unwrap();
        symlink(&outside, target.join("outside-link")).unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();

        let error = bound
            .delete_cancellable(&AtomicBool::new(false), &mut |_| {})
            .expect_err("nested links must fail closed");
        assert!(error.contains("symbolic link"));
        assert_eq!(fs::read(outside.join("sentinel.bin")).unwrap(), b"keep");
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn explicitly_allowed_internal_symlink_is_fingerprinted_and_unlinked_only() {
        use std::os::unix::fs::symlink;

        let home = test_root("allowed-internal-link");
        let target = home.join("Example.app");
        let outside = home.join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(target.join("binary"), b"delete").unwrap();
        fs::write(outside.join("sentinel.bin"), b"keep").unwrap();
        symlink(&outside, target.join("Resources")).unwrap();

        let root = DeleteRoot::open(&home).unwrap();
        let bound = root.bind(Path::new("Example.app")).unwrap();
        let inspection = bound.inspect_allowing_internal_symlinks().unwrap();
        assert_eq!(inspection.item_count, 2);

        let bound = root.bind(Path::new("Example.app")).unwrap();
        assert!(
            bound
                .delete_cancellable_allowing_internal_symlinks(
                    &AtomicBool::new(false),
                    &mut |_| {},
                )
                .unwrap()
        );
        assert!(!target.exists());
        assert_eq!(fs::read(outside.join("sentinel.bin")).unwrap(), b"keep");

        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn child_replacement_during_deletion_fails_closed() {
        use std::os::unix::fs::symlink;

        let home = test_root("child-race");
        let target = home.join("target");
        let child = target.join("b-child");
        let outside = home.join("outside");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(target.join("a-first.bin"), b"delete").unwrap();
        fs::write(outside.join("sentinel.bin"), b"keep").unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();
        let mut replaced = false;

        let error = bound
            .delete_cancellable(&AtomicBool::new(false), &mut |_| {
                if !replaced {
                    fs::remove_dir(&child).unwrap();
                    symlink(&outside, &child).unwrap();
                    replaced = true;
                }
            })
            .expect_err("a child replacement must stop deletion");
        assert!(error.contains("symbolic link"));
        assert_eq!(fs::read(outside.join("sentinel.bin")).unwrap(), b"keep");

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn concurrent_new_entry_reports_partial_deletion() {
        let home = test_root("new-entry");
        let target = home.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("a-first.bin"), b"delete").unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();
        let mut added = false;

        let error = bound
            .delete_cancellable(&AtomicBool::new(false), &mut |_| {
                if !added {
                    fs::write(target.join("late.bin"), b"keep").unwrap();
                    added = true;
                }
            })
            .expect_err("a newly-created entry must keep the root non-empty");
        assert!(error.contains("Could not remove the bound cleanup directory"));
        assert_eq!(fs::read(target.join("late.bin")).unwrap(), b"keep");

        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn special_file_inside_tree_fails_closed() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt as _;

        let home = test_root("special-file");
        let target = home.join("target");
        let fifo = target.join("pipe");
        fs::create_dir_all(&target).unwrap();
        let fifo_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();

        let error = bound
            .delete_cancellable(&AtomicBool::new(false), &mut |_| {})
            .expect_err("special files must not be removed");
        assert!(error.contains("special filesystem object"));
        assert!(fifo.exists());

        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn hard_link_outside_the_tree_keeps_its_contents_and_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = test_root("hard-link");
        let target = home.join("target");
        let outside = home.join("outside.bin");
        fs::create_dir_all(&target).unwrap();
        fs::write(&outside, b"keep").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o444)).unwrap();
        fs::hard_link(&outside, target.join("inside.bin")).unwrap();
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();

        assert!(
            bound
                .delete_cancellable(&AtomicBool::new(false), &mut |_| {})
                .unwrap()
        );
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        assert_eq!(
            fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o444
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn cancellation_leaves_an_accurate_partial_tree() {
        let home = test_root("cancel");
        let target = home.join("target");
        fs::create_dir_all(&target).unwrap();
        for index in 0..8 {
            fs::write(target.join(format!("{index}.bin")), b"data").unwrap();
        }
        let bound = DeleteRoot::open(&home)
            .unwrap()
            .bind(Path::new("target"))
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let mut deleted_entries = 0;
        let completed = bound
            .delete_cancellable(&cancelled, &mut |_| {
                deleted_entries += 1;
                cancelled.store(true, Ordering::Relaxed);
            })
            .unwrap();
        assert!(!completed);
        assert_eq!(deleted_entries, 1);
        assert!(target.exists());
        assert_eq!(fs::read_dir(&target).unwrap().count(), 7);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn bound_file_move_never_overwrites_a_competing_destination() {
        let home = test_root("move-conflict");
        let source = home.join("source/item.plist");
        let destination = home.join("destination/item.plist");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&source, b"source").unwrap();
        let root = SafeFileMoveRoot::open(&home).unwrap();
        let bound = root
            .bind_file_move(
                Path::new("source/item.plist"),
                Path::new("destination/item.plist"),
            )
            .unwrap();
        fs::write(&destination, b"competition").unwrap();

        let error = bound
            .execute()
            .expect_err("the destination must not be replaced");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&destination).unwrap(), b"competition");
        drop(root);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn source_parent_replacement_stops_a_bound_file_move() {
        use std::os::unix::fs::symlink;

        let home = test_root("move-source-parent");
        let source_parent = home.join("source");
        let moved_source_parent = home.join("moved-source");
        let destination_parent = home.join("destination");
        let outside = home.join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&destination_parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(source_parent.join("item.plist"), b"source").unwrap();
        fs::write(outside.join("item.plist"), b"outside").unwrap();
        let root = SafeFileMoveRoot::open(&home).unwrap();
        let bound = root
            .bind_file_move(
                Path::new("source/item.plist"),
                Path::new("destination/item.plist"),
            )
            .unwrap();
        fs::rename(&source_parent, &moved_source_parent).unwrap();
        symlink(&outside, &source_parent).unwrap();

        bound
            .execute()
            .expect_err("the source parent identity must remain bound");
        assert_eq!(
            fs::read(moved_source_parent.join("item.plist")).unwrap(),
            b"source"
        );
        assert_eq!(fs::read(outside.join("item.plist")).unwrap(), b"outside");
        assert!(!destination_parent.join("item.plist").exists());

        fs::remove_file(source_parent).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn destination_parent_replacement_stops_a_bound_file_move() {
        use std::os::unix::fs::symlink;

        let home = test_root("move-destination-parent");
        let source_parent = home.join("source");
        let destination_parent = home.join("destination");
        let moved_destination_parent = home.join("moved-destination");
        let outside = home.join("outside");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&destination_parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(source_parent.join("item.plist"), b"source").unwrap();
        fs::write(outside.join("item.plist"), b"outside").unwrap();
        let root = SafeFileMoveRoot::open(&home).unwrap();
        let bound = root
            .bind_file_move(
                Path::new("source/item.plist"),
                Path::new("destination/item.plist"),
            )
            .unwrap();
        fs::rename(&destination_parent, &moved_destination_parent).unwrap();
        symlink(&outside, &destination_parent).unwrap();

        bound
            .execute()
            .expect_err("the destination parent identity must remain bound");
        assert_eq!(
            fs::read(source_parent.join("item.plist")).unwrap(),
            b"source"
        );
        assert_eq!(fs::read(outside.join("item.plist")).unwrap(), b"outside");
        assert!(!moved_destination_parent.join("item.plist").exists());

        fs::remove_file(destination_parent).unwrap();
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rollback_does_not_remove_a_replaced_destination() {
        use std::os::unix::fs::symlink;

        let home = test_root("move-rollback-race");
        let source = home.join("source/item.plist");
        let destination = home.join("destination/item.plist");
        let linked_original = home.join("destination/linked-original.plist");
        let outside = home.join("outside.plist");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&source, b"source").unwrap();
        fs::write(&outside, b"outside").unwrap();
        let root = SafeFileMoveRoot::open(&home).unwrap();
        let bound = root
            .bind_file_move(
                Path::new("source/item.plist"),
                Path::new("destination/item.plist"),
            )
            .unwrap();

        bound
            .execute_with_hook(|| {
                fs::rename(&destination, &linked_original).unwrap();
                symlink(&outside, &destination).unwrap();
            })
            .expect_err("a replaced rollback target must fail closed");
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert_eq!(fs::read(&linked_original).unwrap(), b"source");
        assert!(
            fs::symlink_metadata(&destination)
                .unwrap()
                .file_type()
                .is_symlink()
        );

        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_move_storage_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let home = test_root("move-private");
        fs::create_dir_all(&home).unwrap();
        let root = SafeFileMoveRoot::open(&home).unwrap();
        root.ensure_directory(Path::new("app/disabled/startup"), true)
            .unwrap();
        assert_eq!(
            fs::metadata(home.join("app/disabled/startup"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::remove_dir_all(home).unwrap();
    }
}
