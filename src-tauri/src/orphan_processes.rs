use std::collections::HashSet;
use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::bounded_command;
use crate::error::CommandError;
use crate::models::{
    OrphanKillOutcome, OrphanKillReport, OrphanKillRequest, OrphanKillStatus, OrphanProcess,
    OrphanReason,
};

const ORPHAN_TERM_GRACE: Duration = Duration::from_secs(4);

/// PIDs of jobs currently registered in the user's launchd domain. Processes
/// with ppid 1 that appear here are launchd's own children (LaunchAgents,
/// login items, background services) and must not be treated as orphans.
pub(crate) fn launchd_registered_pids() -> HashSet<u32> {
    let mut command = std::process::Command::new("launchctl");
    command.arg("list");
    bounded_command::output(&mut command, Duration::from_secs(3), 256 * 1024)
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|stdout| parse_launchctl_list(&stdout))
        .unwrap_or_default()
}

fn parse_launchctl_list(output: &str) -> HashSet<u32> {
    output
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let pid = columns.next()?;
            if pid == "-" {
                return None;
            }
            pid.parse::<u32>().ok()
        })
        .collect()
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_user(UpdateKind::OnlyIfNotSet)
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .without_tasks()
}

fn fresh_system() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
    system
}

#[cfg(unix)]
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

fn is_orphan(
    process: &sysinfo::Process,
    live_pids: &HashSet<u32>,
    launchd_pids: &HashSet<u32>,
) -> Option<OrphanReason> {
    let parent = process.parent()?;
    let parent_pid = parent.as_u32();
    if parent_pid == 1 {
        // Reparented to launchd after the original parent exited — unless the
        // process is itself a launchd-managed job (LaunchAgent, login item).
        if launchd_pids.contains(&process.pid().as_u32()) {
            None
        } else {
            Some(OrphanReason::ParentExited)
        }
    } else if !live_pids.contains(&parent_pid) {
        // The parent is gone but the process has not been reaped by init yet
        // (or a subreaper/container init adopted it under a different pid).
        Some(OrphanReason::ParentMissing)
    } else {
        None
    }
}

/// Credential/session agents are commonly launched from a shell and persist
/// after the shell exits on purpose (ssh-agent, gpg-agent). They are
/// unmanaged by launchd but must never be offered for cleanup.
const KNOWN_SESSION_AGENTS: [&str; 2] = ["ssh-agent", "gpg-agent"];

fn is_known_session_agent(name: &str) -> bool {
    KNOWN_SESSION_AGENTS.contains(&name)
}

pub(crate) fn scan_orphan_processes() -> Result<Vec<OrphanProcess>, CommandError> {
    let mut system = fresh_system();
    let own_pid = sysinfo::get_current_pid()
        .map(|pid| pid.as_u32())
        .unwrap_or(u32::MAX);
    let uid = current_uid();
    let launchd_pids = launchd_registered_pids();

    let candidate_reasons = |system: &System| -> Vec<(u32, OrphanReason)> {
        let live_pids = system
            .processes()
            .values()
            .map(|process| process.pid().as_u32())
            .collect::<HashSet<_>>();
        system
            .processes()
            .values()
            .filter(|process| {
                let pid = process.pid().as_u32();
                pid != own_pid
                    && pid != 0
                    && pid != 1
                    && !matches!(
                        process.status(),
                        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
                    )
                    && process
                        .user_id()
                        .is_some_and(|user_id| **user_id == uid)
                    && !is_known_session_agent(&process.name().to_string_lossy())
            })
            .filter_map(|process| {
                is_orphan(process, &live_pids, &launchd_pids)
                    .map(|reason| (process.pid().as_u32(), reason))
            })
            .collect()
    };

    // A parent can briefly miss a single snapshot while the table is being
    // refreshed. Re-check every parent-missing candidate against a second
    // snapshot before reporting it, so only genuine cases survive.
    let mut confirmed = Vec::new();
    for (pid, reason) in candidate_reasons(&system) {
        match reason {
            OrphanReason::ParentExited => confirmed.push((pid, reason)),
            OrphanReason::ParentMissing => {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    process_refresh_kind(),
                );
                let live_pids = system
                    .processes()
                    .values()
                    .map(|process| process.pid().as_u32())
                    .collect::<HashSet<_>>();
                if let Some(process) = system.process(sysinfo::Pid::from_u32(pid))
                    && is_orphan(process, &live_pids, &launchd_pids)
                        == Some(OrphanReason::ParentMissing)
                {
                    confirmed.push((pid, reason));
                }
            }
        }
    }

    let mut orphans = confirmed
        .into_iter()
        .filter_map(|(pid, reason)| {
            let process = system.process(sysinfo::Pid::from_u32(pid))?;
            let parent = process.parent().map(|parent| parent.as_u32());
            let parent_name = parent
                .and_then(|pid| system.process(sysinfo::Pid::from_u32(pid)))
                .map(|parent| parent.name().to_string_lossy().into_owned());
            Some(OrphanProcess {
                pid,
                start_time: process.start_time(),
                name: process.name().to_string_lossy().into_owned(),
                command_line: process
                    .cmd()
                    .iter()
                    .map(|argument| argument.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join(" "),
                parent_pid: parent,
                parent_name,
                user: uid.to_string(),
                cpu_percent: process.cpu_usage().max(0.0),
                memory_bytes: process.memory(),
                status: format!("{:?}", process.status()),
                orphan_reason: reason,
            })
        })
        .collect::<Vec<_>>();
    orphans.sort_by_key(|process| std::cmp::Reverse(process.memory_bytes));
    Ok(orphans)
}

pub(crate) fn kill_orphan_processes(
    request: &OrphanKillRequest,
) -> Result<OrphanKillReport, CommandError> {
    let mut report = OrphanKillReport {
        outcomes: Vec::with_capacity(request.targets.len()),
    };
    for target in &request.targets {
        report.outcomes.push(kill_one(target.pid, target.expected_start_time, request.force));
    }
    Ok(report)
}

fn kill_one(pid: u32, expected_start_time: u64, force: bool) -> OrphanKillOutcome {
    let system = fresh_system();
    let uid = current_uid();
    let Some(process) = system.process(sysinfo::Pid::from_u32(pid)) else {
        return outcome(pid, String::new(), OrphanKillStatus::Skipped, Some("进程已不存在".to_owned()));
    };
    let name = process.name().to_string_lossy().into_owned();
    if process.start_time() != expected_start_time {
        return outcome(
            pid,
            name,
            OrphanKillStatus::Skipped,
            Some("进程已被替换，未执行操作".to_owned()),
        );
    }
    if process.user_id().is_none_or(|user_id| **user_id != uid) {
        return outcome(
            pid,
            name,
            OrphanKillStatus::Failed,
            Some("只能结束当前用户拥有的进程".to_owned()),
        );
    }
    let live_pids = system
        .processes()
        .values()
        .map(|process| process.pid().as_u32())
        .collect::<HashSet<_>>();
    let launchd_pids = launchd_registered_pids();
    if is_orphan(process, &live_pids, &launchd_pids).is_none() {
        return outcome(
            pid,
            name,
            OrphanKillStatus::Skipped,
            Some("进程已不再是孤儿进程".to_owned()),
        );
    }

    let signaled = unsafe { libc::kill(pid as i32, libc::SIGTERM) } == 0;
    if !signaled {
        return outcome(
            pid,
            name,
            OrphanKillStatus::Failed,
            Some("无法向进程发送结束信号".to_owned()),
        );
    }
    if wait_for_exit(pid, ORPHAN_TERM_GRACE) {
        return outcome(pid, name, OrphanKillStatus::Killed, None);
    }
    if !force {
        return outcome(
            pid,
            name,
            OrphanKillStatus::Survived,
            Some("进程未在等待时间内退出，可强制结束".to_owned()),
        );
    }
    let killed = unsafe { libc::kill(pid as i32, libc::SIGKILL) } == 0
        && wait_for_exit(pid, ORPHAN_TERM_GRACE);
    if killed {
        outcome(pid, name, OrphanKillStatus::ForceKilled, None)
    } else {
        outcome(pid, name, OrphanKillStatus::Failed, Some("强制结束失败".to_owned()))
    }
}

fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
        if !alive {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

fn outcome(
    pid: u32,
    name: String,
    status: OrphanKillStatus,
    message: Option<String>,
) -> OrphanKillOutcome {
    OrphanKillOutcome {
        pid,
        name,
        status,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_known_session_agent, parse_launchctl_list};

    #[test]
    fn launchctl_list_parses_running_pids_only() {
        let output = "PID\tStatus\tLabel\n-\t0\tcom.apple.exited.job\n1234\t0\tcom.apple.running.job\n5678\t0\tcom.example.agent\n";
        let pids = parse_launchctl_list(output);
        assert_eq!(pids, std::collections::HashSet::from([1234, 5678]));
    }

    #[test]
    fn launchctl_list_tolerates_garbage() {
        let pids = parse_launchctl_list("PID\tStatus\tLabel\nnot-a-pid\t0\tweird\n-0\t0\todd\n");
        assert!(pids.is_empty());
    }

    #[test]
    fn session_agents_are_never_cleanup_candidates() {
        assert!(is_known_session_agent("ssh-agent"));
        assert!(is_known_session_agent("gpg-agent"));
        assert!(!is_known_session_agent("leftover-build-worker"));
        assert!(!is_known_session_agent("ssh-agent-helper"));
    }
}
