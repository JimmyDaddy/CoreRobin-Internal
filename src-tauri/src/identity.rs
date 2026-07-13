use crate::error::CommandError;

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
        CommandError::new(
            "identity_unavailable",
            format!("Unable to read /proc process identity: {error}"),
        )
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
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(CommandError::new(
            "identity_unavailable",
            "Windows denied access to the process creation time.",
        ));
    }

    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let succeeded =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 };
    unsafe {
        CloseHandle(handle);
    }

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
    use super::parse_linux_start_ticks;

    #[test]
    fn parses_linux_start_ticks_when_command_contains_spaces() {
        let stat = "123 (worker pool) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20";
        assert_eq!(parse_linux_start_ticks(stat), Some(424_242));
    }

    #[test]
    fn rejects_malformed_linux_stat() {
        assert_eq!(parse_linux_start_ticks("123 malformed"), None);
    }
}
