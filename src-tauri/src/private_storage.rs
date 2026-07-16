use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use cap_fs_ext::{FollowSymlinks, MetadataExt as CapMetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File, Metadata as CapMetadata, OpenOptions};

#[cfg(unix)]
use cap_fs_ext::OpenOptionsExt as _;
#[cfg(unix)]
use cap_std::fs as cap_fs;
#[cfg(unix)]
use cap_std::fs::PermissionsExt as _;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as _;

const TEMP_NAME_ATTEMPTS: usize = 32;

pub fn read_limited(path: &Path, maximum_bytes: u64) -> io::Result<Option<Vec<u8>>> {
    let (parent, name) = split_private_path(path)?;
    let private_dir = match PrivateDir::open(parent, false) {
        Ok(private_dir) => private_dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    private_dir.verify_current_path()?;
    let Some(mut file) = private_dir.open_existing_regular(name)? else {
        return Ok(None);
    };
    let metadata = file.metadata()?;
    if metadata.len() > maximum_bytes {
        drop(file);
        private_dir.remove_regular(name)?;
        return Ok(None);
    }

    let capacity = usize::try_from(metadata.len()).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    Read::by_ref(&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    drop(file);
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > maximum_bytes {
        private_dir.remove_regular(name)?;
        return Ok(None);
    }
    private_dir.verify_current_path()?;
    Ok(Some(bytes))
}

pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_atomic_inner(path, contents, || Ok(()))
}

fn write_atomic_inner(
    path: &Path,
    contents: &[u8],
    before_rename: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let (parent, name) = split_private_path(path)?;
    let private_dir = PrivateDir::open(parent, true)?;
    private_dir.verify_current_path()?;
    private_dir.remove_legacy_temporary(name)?;

    let (temporary_name, mut temporary_file) = private_dir.create_temporary()?;
    let result = (|| {
        temporary_file.write_all(contents)?;
        temporary_file.sync_all()?;
        before_rename()?;
        private_dir.verify_current_path()?;
        private_dir.validate_existing_regular(name)?;
        drop(temporary_file);
        private_dir
            .dir
            .rename(&temporary_name, &private_dir.dir, name)?;
        private_dir.sync()?;
        private_dir.verify_current_path()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = private_dir.dir.remove_file(&temporary_name);
    }
    result
}

pub fn remove(path: &Path) -> io::Result<()> {
    let (parent, name) = split_private_path(path)?;
    let private_dir = match PrivateDir::open(parent, false) {
        Ok(private_dir) => private_dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    private_dir.verify_current_path()?;
    private_dir.remove_regular(name)?;
    private_dir.sync()?;
    private_dir.verify_current_path()
}

fn split_private_path(path: &Path) -> io::Result<(&Path, &OsStr)> {
    if !path.is_absolute() {
        return Err(invalid_data("private storage paths must be absolute"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid_data("private storage path has no parent directory"))?;
    let name = path
        .file_name()
        .filter(|name| *name != OsStr::new(".") && *name != OsStr::new(".."))
        .ok_or_else(|| invalid_data("private storage path has no file name"))?;
    Ok((parent, name))
}

struct PrivateDir {
    path: PathBuf,
    dir: Dir,
    identity: DirectoryIdentity,
}

impl PrivateDir {
    fn open(path: &Path, create: bool) -> io::Result<Self> {
        if create {
            fs::create_dir_all(path)?;
        }
        let path_metadata = fs::symlink_metadata(path)?;
        validate_private_directory(&path_metadata)?;
        let dir = Dir::open_ambient_dir(path, ambient_authority())?;
        let handle_metadata = dir.dir_metadata()?;
        validate_private_directory_handle(&handle_metadata)?;
        let identity = directory_identity(&handle_metadata)?;

        #[cfg(unix)]
        {
            dir.set_permissions(".", cap_fs::Permissions::from_mode(0o700))?;
        }

        let private_dir = Self {
            path: path.to_path_buf(),
            dir,
            identity,
        };
        private_dir.verify_current_path()?;
        Ok(private_dir)
    }

    fn verify_current_path(&self) -> io::Result<()> {
        let metadata = fs::symlink_metadata(&self.path)?;
        validate_private_directory(&metadata)?;
        let current = Dir::open_ambient_dir(&self.path, ambient_authority())?;
        let handle_metadata = current.dir_metadata()?;
        validate_private_directory_handle(&handle_metadata)?;
        if directory_identity(&handle_metadata)? != self.identity {
            return Err(invalid_data(
                "private storage directory changed during the operation",
            ));
        }
        Ok(())
    }

    fn create_temporary(&self) -> io::Result<(OsString, File)> {
        for _ in 0..TEMP_NAME_ATTEMPTS {
            let name = random_temporary_name()?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            options.follow(FollowSymlinks::No);
            #[cfg(unix)]
            options.mode(0o600);
            match self.dir.open_with(&name, &options) {
                Ok(file) => {
                    validate_private_file_handle(&file)?;
                    #[cfg(unix)]
                    file.set_permissions(cap_fs::Permissions::from_mode(0o600))?;
                    return Ok((name, file));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique private storage temporary file",
        ))
    }

    fn open_existing_regular(&self, name: &OsStr) -> io::Result<Option<File>> {
        let metadata = match self.dir.symlink_metadata(name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(invalid_data(
                "private storage entry is not a regular no-follow file",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        options.follow(FollowSymlinks::No);
        let file = self.dir.open_with(name, &options)?;
        validate_private_file_handle(&file)?;
        Ok(Some(file))
    }

    fn validate_existing_regular(&self, name: &OsStr) -> io::Result<()> {
        drop(self.open_existing_regular(name)?);
        Ok(())
    }

    fn remove_regular(&self, name: &OsStr) -> io::Result<()> {
        if self.open_existing_regular(name)?.is_none() {
            return Ok(());
        }
        self.dir.remove_file(name)
    }

    fn remove_legacy_temporary(&self, name: &OsStr) -> io::Result<()> {
        let mut legacy_name = OsString::from(name);
        legacy_name.push(".tmp");
        self.remove_regular(&legacy_name)
    }

    fn sync(&self) -> io::Result<()> {
        sync_private_directory(&self.dir)
    }
}

#[cfg(target_os = "linux")]
fn sync_private_directory(directory: &Dir) -> io::Result<()> {
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
fn sync_private_directory(directory: &Dir) -> io::Result<()> {
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

fn random_temporary_name() -> io::Result<OsString> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let mut encoded = String::with_capacity(32);
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(OsString::from(format!(".core-robin-cache-{encoded}.tmp")))
}

fn validate_private_file_handle(file: &File) -> io::Result<()> {
    let metadata = file.try_clone()?.into_std().metadata()?;
    if !metadata.is_file() {
        return Err(invalid_data("private storage entry is not a regular file"));
    }
    validate_current_owner(&metadata)
}

fn validate_private_directory(metadata: &fs::Metadata) -> io::Result<()> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid_data(
            "private storage directory is not a no-follow directory",
        ));
    }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x0400 != 0 {
        return Err(invalid_data(
            "private storage directory must not be a reparse point",
        ));
    }
    validate_current_owner(metadata)
}

fn validate_private_directory_handle(metadata: &CapMetadata) -> io::Result<()> {
    if !metadata.is_dir() {
        return Err(invalid_data("private storage handle is not a directory"));
    }
    #[cfg(unix)]
    if cap_std::fs::MetadataExt::uid(metadata) != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private storage handle is not owned by the current user",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_current_owner(metadata: &fs::Metadata) -> io::Result<()> {
    let effective_user = unsafe { libc::geteuid() };
    if metadata.uid() != effective_user {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private storage entry is not owned by the current user",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn validate_current_owner(_metadata: &fs::Metadata) -> io::Result<()> {
    // The application data directory inherits the current user's Windows ACL.
    // Reparse points are rejected above and all child operations stay relative
    // to the opened directory handle.
    Ok(())
}

type DirectoryIdentity = (u64, u64);

fn directory_identity(metadata: &CapMetadata) -> io::Result<DirectoryIdentity> {
    Ok((CapMetadataExt::dev(metadata), CapMetadataExt::ino(metadata)))
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_root(suffix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("core-robin-private-{suffix}-{nonce}"))
    }

    #[test]
    fn private_file_round_trips_and_is_removed() {
        let root = test_root("round-trip");
        let path = root.join("app/scan.json");
        write_atomic(&path, b"first").unwrap();
        assert_eq!(read_limited(&path, 64).unwrap(), Some(b"first".to_vec()));
        write_atomic(&path, b"second").unwrap();
        assert_eq!(read_limited(&path, 64).unwrap(), Some(b"second".to_vec()));
        remove(&path).unwrap();
        assert_eq!(read_limited(&path, 64).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_storage_enforces_owner_only_permissions() {
        let root = test_root("permissions");
        let path = root.join("app/scan.json");
        write_atomic(&path, b"private").unwrap();
        assert_eq!(
            fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn target_and_legacy_temporary_symlinks_never_touch_their_targets() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink");
        let app = root.join("app");
        let sentinel = root.join("sentinel");
        fs::create_dir_all(&app).unwrap();
        fs::write(&sentinel, b"outside").unwrap();
        let path = app.join("scan.json");
        symlink(&sentinel, &path).unwrap();
        assert!(read_limited(&path, 64).is_err());
        assert!(write_atomic(&path, b"replacement").is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside");

        fs::remove_file(&path).unwrap();
        let legacy = app.join("scan.json.tmp");
        symlink(&sentinel, &legacy).unwrap();
        assert!(write_atomic(&path, b"replacement").is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn parent_replacement_cannot_redirect_the_atomic_write() {
        use std::os::unix::fs::symlink;

        let root = test_root("parent-race");
        let app = root.join("app");
        let moved = root.join("moved-app");
        let outside = root.join("outside");
        let path = app.join("scan.json");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("scan.json"), b"sentinel").unwrap();
        write_atomic(&path, b"old").unwrap();

        let error = write_atomic_inner(&path, b"new", || {
            fs::rename(&app, &moved)?;
            symlink(&outside, &app)
        })
        .expect_err("replaced parent must fail closed");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read(outside.join("scan.json")).unwrap(), b"sentinel");
        assert_eq!(fs::read(moved.join("scan.json")).unwrap(), b"old");
        assert_eq!(
            fs::read_dir(&moved).unwrap().filter_map(Result::ok).count(),
            1,
            "failed writes must clean their random temporary file"
        );

        fs::remove_file(&app).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_write_preserves_the_previous_cache() {
        let root = test_root("interrupted");
        let path = root.join("app/scan.json");
        write_atomic(&path, b"old").unwrap();
        let error = write_atomic_inner(&path, b"new", || {
            Err(io::Error::new(io::ErrorKind::Interrupted, "injected"))
        })
        .expect_err("injected failure must be returned");
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(read_limited(&path, 64).unwrap(), Some(b"old".to_vec()));
        assert_eq!(
            fs::read_dir(path.parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
}
