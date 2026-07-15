use std::collections::HashMap;

use crate::error::CommandError;

#[derive(Clone, Debug)]
struct CachedBirthToken {
    start_time: u64,
    token: Option<String>,
}

#[derive(Default)]
pub struct BirthTokenCache {
    entries: HashMap<u32, CachedBirthToken>,
}

impl BirthTokenCache {
    pub fn retain_live(&mut self, live: &HashMap<u32, u64>) {
        self.entries.retain(|pid, cached| {
            live.get(pid)
                .is_some_and(|start_time| *start_time == cached.start_time)
        });
    }

    pub fn resolve(&mut self, pid: u32, start_time: u64) -> Option<String> {
        self.resolve_with(pid, start_time, read_birth_token)
    }

    fn resolve_with<F>(&mut self, pid: u32, start_time: u64, read: F) -> Option<String>
    where
        F: FnOnce(u32) -> Result<String, CommandError>,
    {
        if let Some(cached) = self.entries.get(&pid)
            && cached.start_time == start_time
        {
            return cached.token.clone();
        }

        let token = read(pid).ok();
        self.entries.insert(
            pid,
            CachedBirthToken {
                start_time,
                token: token.clone(),
            },
        );
        token
    }
}

pub fn read_birth_token(pid: u32) -> Result<String, CommandError> {
    #[cfg(target_os = "macos")]
    {
        return read_macos_birth_token(pid);
    }

    #[cfg(target_os = "linux")]
    {
        return read_linux_birth_token(pid);
    }

    #[cfg(windows)]
    {
        return read_windows_birth_token(pid);
    }

    #[allow(unreachable_code)]
    Err(CommandError::new(
        "identity_unavailable",
        "This platform does not expose a precise process birth token yet.",
    ))
}

pub fn ensure_birth_token(pid: u32, expected: &str) -> Result<String, CommandError> {
    verify_birth_token(expected, read_birth_token(pid)?)
}

fn verify_birth_token(expected: &str, current: String) -> Result<String, CommandError> {
    if current == expected {
        Ok(current)
    } else {
        Err(CommandError::new(
            "stale_process",
            "The PID now belongs to a different process; no action was taken.",
        ))
    }
}

#[cfg(target_os = "macos")]
fn read_macos_birth_token(pid: u32) -> Result<String, CommandError> {
    use std::mem;

    let mut info = unsafe { mem::zeroed::<libc::proc_bsdinfo>() };
    let expected_size = mem::size_of::<libc::proc_bsdinfo>();
    let received_size = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            expected_size as libc::c_int,
        )
    };

    if received_size != expected_size as libc::c_int {
        return Err(CommandError::new(
            "identity_unavailable",
            "macOS did not return precise process identity information.",
        ));
    }

    Ok(format!(
        "macos:{}:{}",
        info.pbi_start_tvsec, info.pbi_start_tvusec
    ))
}

#[cfg(target_os = "linux")]
fn read_linux_birth_token(pid: u32) -> Result<String, CommandError> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CommandError::new(
                "process_exited",
                "The selected process is no longer running.",
            )
        } else {
            CommandError::new(
                "identity_unavailable",
                format!("Unable to read /proc process identity: {error}"),
            )
        }
    })?;
    let start_ticks = parse_linux_start_ticks(&stat).ok_or_else(|| {
        CommandError::new(
            "identity_unavailable",
            "The Linux process identity record was malformed.",
        )
    })?;

    Ok(format!("linux:{start_ticks}"))
}

#[cfg(any(test, target_os = "linux"))]
fn parse_linux_start_ticks(stat: &str) -> Option<u64> {
    let command_end = stat.rfind(')')?;
    stat.get(command_end + 1..)?
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(windows)]
fn read_windows_birth_token(pid: u32) -> Result<String, CommandError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(CommandError::new(
            "identity_unavailable",
            "Windows denied access to the process creation time.",
        ));
    }

    let result = windows_birth_token_from_handle(handle);
    unsafe {
        CloseHandle(handle);
    }
    result
}

#[cfg(windows)]
pub(crate) fn windows_birth_token_from_handle(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Result<String, CommandError> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let succeeded =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 };

    if !succeeded {
        return Err(CommandError::new(
            "identity_unavailable",
            "Windows did not return the process creation time.",
        ));
    }

    let file_time = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    Ok(format!("windows:{file_time}"))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{BirthTokenCache, parse_linux_start_ticks, verify_birth_token};
    use crate::error::CommandError;

    #[test]
    fn parses_linux_start_ticks_when_command_contains_spaces() {
        let stat = "123 (worker pool) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20";
        assert_eq!(parse_linux_start_ticks(stat), Some(424_242));
    }

    #[test]
    fn rejects_malformed_linux_stat() {
        assert_eq!(parse_linux_start_ticks("123 malformed"), None);
    }

    #[test]
    fn rejects_a_stale_birth_token() {
        let error = verify_birth_token("expected", "replacement".to_owned()).unwrap_err();
        assert_eq!(error.code, "stale_process");
    }

    #[test]
    fn accepts_the_same_birth_token() {
        assert_eq!(
            verify_birth_token("expected", "expected".to_owned()).unwrap(),
            "expected"
        );
    }

    #[test]
    fn reuses_birth_tokens_for_the_same_process_identity() {
        let mut cache = BirthTokenCache::default();
        let mut reads = 0;

        let first = cache.resolve_with(42, 100, |_| {
            reads += 1;
            Ok("token-a".to_owned())
        });
        let second = cache.resolve_with(42, 100, |_| {
            reads += 1;
            Ok("token-b".to_owned())
        });

        assert_eq!(first.as_deref(), Some("token-a"));
        assert_eq!(second.as_deref(), Some("token-a"));
        assert_eq!(reads, 1);
    }

    #[test]
    fn refreshes_birth_tokens_when_a_pid_is_reused() {
        let mut cache = BirthTokenCache::default();
        let first = cache.resolve_with(42, 100, |_| Ok("token-a".to_owned()));
        let second = cache.resolve_with(42, 200, |_| Ok("token-b".to_owned()));

        assert_eq!(first.as_deref(), Some("token-a"));
        assert_eq!(second.as_deref(), Some("token-b"));
    }

    #[test]
    fn caches_unavailable_tokens_until_the_process_identity_changes() {
        let mut cache = BirthTokenCache::default();
        let mut reads = 0;
        let unavailable = || CommandError::new("identity_unavailable", "unavailable");

        assert_eq!(
            cache.resolve_with(42, 100, |_| {
                reads += 1;
                Err(unavailable())
            }),
            None
        );
        assert_eq!(
            cache.resolve_with(42, 100, |_| {
                reads += 1;
                Ok("unexpected".to_owned())
            }),
            None
        );
        assert_eq!(reads, 1);
    }

    #[test]
    fn prunes_processes_that_have_disappeared() {
        let mut cache = BirthTokenCache::default();
        cache.resolve_with(42, 100, |_| Ok("token-a".to_owned()));
        cache.resolve_with(43, 100, |_| Ok("token-b".to_owned()));

        cache.retain_live(&HashMap::from([(43, 100)]));

        let mut reads = 0;
        cache.resolve_with(42, 100, |_| {
            reads += 1;
            Ok("token-c".to_owned())
        });
        assert_eq!(reads, 1);
    }
}
