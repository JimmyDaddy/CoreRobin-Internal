use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub fn output(
    command: &mut Command,
    timeout: Duration,
    maximum_output_bytes: usize,
) -> io::Result<Output> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("command stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("command stderr was not captured"))?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, maximum_output_bytes));
    let stderr_reader = thread::spawn(move || read_capped(stderr, maximum_output_bytes));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            terminate_child(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "system command exceeded its time limit",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stdout_truncated) = join_reader(stdout_reader)?;
    let (stderr, stderr_truncated) = join_reader(stderr_reader)?;
    if stdout_truncated || stderr_truncated {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "system command exceeded its output limit",
        ));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn terminate_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let process_group = -(child.id() as libc::pid_t);
        // The command is its own process-group leader, so descendants holding
        // inherited output pipes cannot keep the watchdog blocked.
        unsafe {
            libc::kill(process_group, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn read_capped(mut reader: impl Read, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut captured = Vec::with_capacity(limit.min(64 * 1_024));
    let mut buffer = [0_u8; 8 * 1_024];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let keep = remaining.min(read);
        captured.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((captured, truncated))
}

fn join_reader(
    reader: thread::JoinHandle<io::Result<(Vec<u8>, bool)>>,
) -> io::Result<(Vec<u8>, bool)> {
    reader
        .join()
        .map_err(|_| io::Error::other("system command output reader panicked"))?
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Command;
    use std::time::{Duration, Instant};

    use super::output;

    #[test]
    fn captures_bounded_output() {
        let result = output(
            Command::new("/bin/sh").args(["-c", "printf ok; printf warning >&2"]),
            Duration::from_secs(1),
            64,
        )
        .unwrap();
        assert_eq!(result.stdout, b"ok");
        assert_eq!(result.stderr, b"warning");
    }

    #[test]
    fn terminates_commands_that_exceed_the_deadline() {
        let started = Instant::now();
        let error = output(
            Command::new("/bin/sh").args(["-c", "sleep 2 & wait"]),
            Duration::from_millis(50),
            64,
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
