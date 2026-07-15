use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File, Metadata, OpenOptions};

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
            if path_metadata.uid() != unsafe { libc::geteuid() } {
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
            handle,
        })
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
    handle: BoundHandle,
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

    pub fn delete_cancellable(
        &self,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
    ) -> Result<bool, String> {
        self.delete_cancellable_with_hook(cancelled, on_entry_deleted, || {})
    }

    fn delete_cancellable_with_hook(
        &self,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
        after_root_validation: impl FnOnce(),
    ) -> Result<bool, String> {
        self.current_entry_metadata()
            .map_err(|error| format!("Cleanup target changed before deletion: {error}"))?;
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        after_root_validation();

        match &self.handle {
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
                self.delete_directory(directory, cancelled, on_entry_deleted)
            }
        }
    }

    fn delete_directory(
        &self,
        root: &Dir,
        cancelled: &AtomicBool,
        on_entry_deleted: &mut dyn FnMut(u64),
    ) -> Result<bool, String> {
        let root_directory = root
            .try_clone()
            .map_err(|error| format!("Could not retain the cleanup directory: {error}"))?;
        let root_entries = read_entry_names(&root_directory, Path::new("."))?;
        let mut frames = vec![DirectoryFrame {
            directory: root_directory,
            name_in_parent: None,
            identity: self.identity,
            display_path: Path::new(".").to_path_buf(),
            entries: root_entries,
            next_entry: 0,
        }];
        let mut seen_files = HashSet::new();

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
                    return Err(format!(
                        "Refused to delete {} because it is a symbolic link or reparse point.",
                        display_path.display()
                    ));
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
                parent.directory.remove_dir(&name).map_err(|error| {
                    format!(
                        "Could not remove {} after deleting its contents: {error}",
                        completed.display_path.display()
                    )
                })?;
                on_entry_deleted(0);
            }
        }

        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        verify_entry_identity(&self.parent, &self.name, self.identity)
            .map_err(|error| format!("Cleanup target changed before final removal: {error}"))?;
        self.parent
            .remove_dir(&self.name)
            .map_err(|error| format!("Could not remove the bound cleanup directory: {error}"))?;
        on_entry_deleted(0);
        Ok(true)
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

#[derive(Debug)]
struct DirectoryFrame {
    directory: Dir,
    name_in_parent: Option<OsString>,
    identity: FileIdentity,
    display_path: std::path::PathBuf,
    entries: Vec<OsString>,
    next_entry: usize,
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
        std::env::temp_dir().join(format!("status-orbit-safe-fs-{suffix}-{nonce}"))
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
}
