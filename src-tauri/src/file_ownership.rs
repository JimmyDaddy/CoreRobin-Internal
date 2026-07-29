use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileOwnership {
    CurrentUser,
    OtherUser,
    Unavailable,
}

#[cfg(unix)]
pub fn ownership(path: &Path) -> FileOwnership {
    use std::os::unix::fs::MetadataExt;

    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.uid() == unsafe { libc::geteuid() } => FileOwnership::CurrentUser,
        Ok(_) => FileOwnership::OtherUser,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => FileOwnership::CurrentUser,
        Err(_) => FileOwnership::Unavailable,
    }
}

#[cfg(windows)]
pub fn ownership(path: &Path) -> FileOwnership {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, LocalFree};
    use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut encoded_path = path.as_os_str().encode_wide().collect::<Vec<_>>();
    encoded_path.push(0);
    let mut owner: PSID = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: all output pointers are valid and the path is NUL terminated.
    let security_result = unsafe {
        GetNamedSecurityInfoW(
            encoded_path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if security_result != ERROR_SUCCESS || owner.is_null() {
        if !descriptor.is_null() {
            unsafe {
                LocalFree(descriptor.cast());
            }
        }
        return FileOwnership::Unavailable;
    }

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        unsafe {
            LocalFree(descriptor.cast());
        }
        return FileOwnership::Unavailable;
    }
    let mut required_bytes = 0_u32;
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut required_bytes,
        );
    }
    if required_bytes == 0 {
        unsafe {
            CloseHandle(token);
            LocalFree(descriptor.cast());
        }
        return FileOwnership::Unavailable;
    }
    let word_size = std::mem::size_of::<usize>();
    let mut token_buffer = vec![0_usize; (required_bytes as usize).div_ceil(word_size)];
    let token_result = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            token_buffer.as_mut_ptr().cast(),
            required_bytes,
            &mut required_bytes,
        )
    };
    let result = if token_result == 0 {
        FileOwnership::Unavailable
    } else {
        let token_user = unsafe { &*(token_buffer.as_ptr().cast::<TOKEN_USER>()) };
        if unsafe { EqualSid(owner, token_user.User.Sid) } != 0 {
            FileOwnership::CurrentUser
        } else {
            FileOwnership::OtherUser
        }
    };
    unsafe {
        CloseHandle(token);
        LocalFree(descriptor.cast());
    }
    result
}

#[cfg(not(any(unix, windows)))]
pub fn ownership(_path: &Path) -> FileOwnership {
    FileOwnership::Unavailable
}
