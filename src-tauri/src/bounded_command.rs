use std::collections::HashMap;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const CIRCUIT_FAILURE_THRESHOLD: u32 = 3;
const CIRCUIT_COOLDOWN: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default)]
struct CircuitState {
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

fn command_circuits() -> &'static Mutex<HashMap<&'static str, CircuitState>> {
    static CIRCUITS: OnceLock<Mutex<HashMap<&'static str, CircuitState>>> = OnceLock::new();
    CIRCUITS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn output_with_circuit(
    circuit_key: &'static str,
    command: &mut Command,
    timeout: Duration,
    maximum_output_bytes: usize,
) -> io::Result<Output> {
    {
        let mut circuits = command_circuits()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(state) = circuits.get_mut(circuit_key)
            && let Some(open_until) = state.open_until
        {
            if Instant::now() < open_until {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "system command is cooling down after repeated failures",
                ));
            }
            state.open_until = None;
            state.consecutive_failures = 0;
        }
    }

    let result = output(command, timeout, maximum_output_bytes);
    let succeeded = result.as_ref().is_ok_and(|output| output.status.success());
    let mut circuits = command_circuits()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if succeeded {
        circuits.remove(circuit_key);
    } else {
        let state = circuits.entry(circuit_key).or_default();
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        if state.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD {
            state.open_until = Some(Instant::now() + CIRCUIT_COOLDOWN);
        }
    }
    result
}

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

    use super::{command_circuits, output, output_with_circuit};

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

    #[test]
    fn circuit_breaker_stops_repeatedly_failing_system_commands() {
        const KEY: &str = "bounded-command-test";
        command_circuits().lock().unwrap().remove(KEY);
        for _ in 0..3 {
            let output = output_with_circuit(
                KEY,
                Command::new("/bin/sh").args(["-c", "exit 1"]),
                Duration::from_secs(1),
                64,
            )
            .unwrap();
            assert!(!output.status.success());
        }
        let error = output_with_circuit(
            KEY,
            Command::new("/bin/sh").args(["-c", "exit 0"]),
            Duration::from_secs(1),
            64,
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        command_circuits().lock().unwrap().remove(KEY);
    }
}
