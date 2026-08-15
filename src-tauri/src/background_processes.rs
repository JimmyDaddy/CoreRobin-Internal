use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[cfg(target_os = "macos")]
use crate::bounded_command;
use crate::models::{BackgroundProcessState, ProcessKey};

const LIKELY_LEFTOVER_MIN_AGE: Duration = Duration::from_secs(30);
const LIKELY_LEFTOVER_MIN_SAMPLES: u32 = 3;
#[cfg(target_os = "macos")]
const MANAGER_QUERY_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct BackgroundProcessAssessment {
    pub state: Option<BackgroundProcessState>,
    pub observed_seconds: Option<u64>,
    pub previous_parent_pid: Option<u32>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProcessObservation {
    pub key: Option<ProcessKey>,
    pub parent_pid: Option<u32>,
    pub parent_key: Option<ProcessKey>,
    pub current_user_owned: bool,
    pub executable: Option<PathBuf>,
    pub protected: bool,
    pub is_zombie: bool,
    pub manager_registered: bool,
}

#[derive(Clone, Debug)]
struct TrackedProcess {
    previous_parent: Option<ProcessKey>,
    previous_parent_pid: Option<u32>,
    suspect_since: Option<Instant>,
    suspect_samples: u32,
    assessment: BackgroundProcessAssessment,
}

impl TrackedProcess {
    fn new(observation: &ProcessObservation) -> Self {
        let observed_parent = observed_parent(observation);
        Self {
            previous_parent: observed_parent.as_ref().map(|(parent, _)| parent.clone()),
            previous_parent_pid: observed_parent.map(|(_, pid)| pid),
            suspect_since: None,
            suspect_samples: 0,
            assessment: BackgroundProcessAssessment::default(),
        }
    }

    fn clear_suspicion(&mut self) {
        self.suspect_since = None;
        self.suspect_samples = 0;
    }
}

#[derive(Default)]
pub(crate) struct BackgroundProcessTracker {
    tracked: HashMap<ProcessKey, TrackedProcess>,
}

impl BackgroundProcessTracker {
    pub(crate) fn update(
        &mut self,
        observations: &[ProcessObservation],
        manager_available: bool,
        now: Instant,
    ) -> HashMap<ProcessKey, BackgroundProcessAssessment> {
        let live_keys = observations
            .iter()
            .filter_map(|observation| observation.key.clone())
            .collect::<HashSet<_>>();
        self.tracked.retain(|key, _| live_keys.contains(key));

        for observation in observations {
            let Some(key) = observation.key.as_ref() else {
                continue;
            };
            let tracked = self
                .tracked
                .entry(key.clone())
                .or_insert_with(|| TrackedProcess::new(observation));

            if observation.protected {
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment::default();
                continue;
            }

            if observation.is_zombie {
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment {
                    state: Some(BackgroundProcessState::Zombie),
                    observed_seconds: None,
                    previous_parent_pid: tracked.previous_parent_pid,
                };
                continue;
            }

            if observation.manager_registered
                || observation
                    .executable
                    .as_deref()
                    .is_some_and(|path| is_macos_managed_executable(path, observation.parent_pid))
            {
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment {
                    state: Some(BackgroundProcessState::Managed),
                    observed_seconds: None,
                    previous_parent_pid: tracked.previous_parent_pid,
                };
                continue;
            }

            if !observation.current_user_owned {
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment::default();
                continue;
            }

            if let Some((parent_key, parent_pid)) = observed_parent(observation) {
                tracked.previous_parent = Some(parent_key);
                tracked.previous_parent_pid = Some(parent_pid);
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment::default();
                continue;
            }

            // PPID 1 is only a current tree relationship. It is not evidence
            // that a running process is abandoned. CoreRobin must first have
            // observed an exact parent identity and then see that identity
            // disappear from a later snapshot.
            let Some(previous_parent) = tracked.previous_parent.as_ref() else {
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment {
                    state: Some(BackgroundProcessState::Unconfirmed),
                    observed_seconds: None,
                    previous_parent_pid: None,
                };
                continue;
            };

            if !manager_available || live_keys.contains(previous_parent) {
                tracked.clear_suspicion();
                tracked.assessment = BackgroundProcessAssessment {
                    state: Some(BackgroundProcessState::Unconfirmed),
                    observed_seconds: None,
                    previous_parent_pid: tracked.previous_parent_pid,
                };
                continue;
            }

            let suspect_since = *tracked.suspect_since.get_or_insert(now);
            tracked.suspect_samples = tracked.suspect_samples.saturating_add(1);
            let observed_for = now.saturating_duration_since(suspect_since);
            let state = if tracked.suspect_samples >= LIKELY_LEFTOVER_MIN_SAMPLES
                && observed_for >= LIKELY_LEFTOVER_MIN_AGE
            {
                BackgroundProcessState::LikelyLeftover
            } else {
                BackgroundProcessState::Unconfirmed
            };
            tracked.assessment = BackgroundProcessAssessment {
                state: Some(state),
                observed_seconds: Some(observed_for.as_secs()),
                previous_parent_pid: tracked.previous_parent_pid,
            };
        }

        self.tracked
            .iter()
            .map(|(key, tracked)| (key.clone(), tracked.assessment))
            .collect()
    }

    pub(crate) fn assessment(&self, key: &ProcessKey) -> Option<BackgroundProcessAssessment> {
        self.tracked.get(key).map(|tracked| tracked.assessment)
    }
}

fn observed_parent(observation: &ProcessObservation) -> Option<(ProcessKey, u32)> {
    let parent_pid = observation.parent_pid.filter(|pid| *pid > 1)?;
    let parent_key = observation.parent_key.clone()?;
    Some((parent_key, parent_pid))
}

/// Returns `None` when the current platform cannot provide a trustworthy
/// manager inventory. Callers must fail closed and avoid promoting candidates
/// while management provenance is unavailable.
pub(crate) fn launchd_registered_pids() -> Option<HashSet<u32>> {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("launchctl");
        command.arg("list");
        bounded_command::output(&mut command, MANAGER_QUERY_TIMEOUT, 256 * 1024)
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|stdout| parse_launchctl_list(&stdout))
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_launchctl_list(output: &str) -> HashSet<u32> {
    output
        .lines()
        .filter_map(|line| {
            let pid = line.split_whitespace().next()?;
            if pid == "-" {
                return None;
            }
            pid.parse::<u32>().ok()
        })
        .collect()
}

pub(crate) fn is_macos_managed_executable(path: &Path, parent_pid: Option<u32>) -> bool {
    #[cfg(target_os = "macos")]
    {
        let system_path = path.starts_with("/System")
            || path.starts_with("/usr/bin")
            || path.starts_with("/usr/libexec")
            || path.starts_with("/bin")
            || path.starts_with("/sbin")
            || path.starts_with("/Library/Apple");

        let managed_bundle = path.ancestors().any(|ancestor| {
            ancestor.extension().is_some_and(|extension| {
                let extension = extension.to_string_lossy();
                extension.eq_ignore_ascii_case("xpc") || extension.eq_ignore_ascii_case("appex")
            })
        });
        managed_bundle || (system_path && parent_pid == Some(1))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, parent_pid);
        false
    }
}

pub(crate) fn managed_process_protection_reason(pid: u32) -> Option<&'static str> {
    let mut system = System::new();
    let pids = [sysinfo::Pid::from_u32(pid)];
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .without_tasks(),
    );
    let process = system.process(pids[0])?;
    if matches!(
        process.status(),
        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
    ) {
        return Some(
            "This process has already exited and is waiting for the operating system to reap it.",
        );
    }
    if process.exe().is_some_and(|path| {
        is_macos_managed_executable(path, process.parent().map(|parent| parent.as_u32()))
    }) {
        return Some("This process is managed by macOS or its owning application.");
    }
    if launchd_registered_pids().is_some_and(|pids| pids.contains(&pid)) {
        return Some("This process is managed by macOS or its owning application.");
    }
    None
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use super::{BackgroundProcessTracker, ProcessObservation, parse_launchctl_list};
    use crate::models::{BackgroundProcessState, ProcessKey};

    fn key(pid: u32, token: &str) -> ProcessKey {
        ProcessKey {
            pid,
            birth_token: token.to_owned(),
        }
    }

    fn observation(process_key: ProcessKey, parent: Option<ProcessKey>) -> ProcessObservation {
        ProcessObservation {
            key: Some(process_key),
            parent_pid: parent.as_ref().map(|parent| parent.pid).or(Some(1)),
            parent_key: parent,
            current_user_owned: true,
            executable: Some(PathBuf::from("/tmp/example-worker")),
            protected: false,
            is_zombie: false,
            manager_registered: false,
        }
    }

    #[test]
    fn ppid_one_without_observed_parent_never_becomes_likely() {
        let now = Instant::now();
        let process = key(42, "worker");
        let mut tracker = BackgroundProcessTracker::default();
        for offset in [0, 10, 40, 120] {
            let results = tracker.update(
                &[observation(process.clone(), None)],
                true,
                now + Duration::from_secs(offset),
            );
            assert_eq!(
                results.get(&process).and_then(|result| result.state),
                Some(BackgroundProcessState::Unconfirmed)
            );
        }
    }

    #[test]
    fn requires_parent_history_time_and_repeated_samples() {
        let now = Instant::now();
        let parent = key(10, "parent");
        let child = key(11, "child");
        let mut tracker = BackgroundProcessTracker::default();
        tracker.update(
            &[
                observation(parent.clone(), None),
                observation(child.clone(), Some(parent.clone())),
            ],
            true,
            now,
        );

        for offset in [1, 15] {
            let results = tracker.update(
                &[observation(child.clone(), None)],
                true,
                now + Duration::from_secs(offset),
            );
            assert_eq!(
                results.get(&child).and_then(|result| result.state),
                Some(BackgroundProcessState::Unconfirmed)
            );
        }
        let results = tracker.update(
            &[observation(child.clone(), None)],
            true,
            now + Duration::from_secs(32),
        );
        assert_eq!(
            results.get(&child).and_then(|result| result.state),
            Some(BackgroundProcessState::LikelyLeftover)
        );
        assert_eq!(
            results
                .get(&child)
                .and_then(|result| result.previous_parent_pid),
            Some(parent.pid)
        );
    }

    #[test]
    fn manager_failure_prevents_candidate_promotion() {
        let now = Instant::now();
        let parent = key(20, "parent");
        let child = key(21, "child");
        let mut tracker = BackgroundProcessTracker::default();
        tracker.update(
            &[
                observation(parent.clone(), None),
                observation(child.clone(), Some(parent)),
            ],
            true,
            now,
        );
        let results = tracker.update(
            &[observation(child.clone(), None)],
            false,
            now + Duration::from_secs(60),
        );
        assert_eq!(
            results.get(&child).and_then(|result| result.state),
            Some(BackgroundProcessState::Unconfirmed)
        );
    }

    #[test]
    fn registered_manager_and_zombie_are_classified_separately() {
        let now = Instant::now();
        let managed = key(30, "managed");
        let zombie = key(31, "zombie");
        let mut managed_observation = observation(managed.clone(), None);
        managed_observation.manager_registered = true;
        let mut zombie_observation = observation(zombie.clone(), None);
        zombie_observation.is_zombie = true;
        let results = BackgroundProcessTracker::default().update(
            &[managed_observation, zombie_observation],
            true,
            now,
        );
        assert_eq!(
            results.get(&managed).and_then(|result| result.state),
            Some(BackgroundProcessState::Managed)
        );
        assert_eq!(
            results.get(&zombie).and_then(|result| result.state),
            Some(BackgroundProcessState::Zombie)
        );
    }

    #[test]
    fn launchctl_list_parses_running_pids_only() {
        let output = "PID\tStatus\tLabel\n-\t0\tcom.apple.exited.job\n1234\t0\tcom.apple.running.job\n5678\t0\tcom.example.agent\n";
        let pids = parse_launchctl_list(output);
        assert_eq!(pids, std::collections::HashSet::from([1234, 5678]));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_managed_paths_require_real_management_context() {
        use std::path::Path;

        assert!(super::is_macos_managed_executable(
            Path::new(
                "/Applications/Browser.app/Contents/XPCServices/com.example.worker.xpc/Contents/MacOS/worker",
            ),
            Some(99),
        ));
        assert!(super::is_macos_managed_executable(
            Path::new("/System/Library/CoreServices/helper"),
            Some(1),
        ));
        assert!(!super::is_macos_managed_executable(
            Path::new("/bin/sleep"),
            Some(99),
        ));
    }

    #[test]
    fn pid_reuse_does_not_inherit_parent_history() {
        let now = Instant::now();
        let parent = key(40, "parent");
        let original = key(41, "original");
        let replacement = key(41, "replacement");
        let mut tracker = BackgroundProcessTracker::default();
        tracker.update(
            &[
                observation(parent.clone(), None),
                observation(original, Some(parent)),
            ],
            true,
            now,
        );
        let results = tracker.update(
            &[observation(replacement.clone(), None)],
            true,
            now + Duration::from_secs(60),
        );
        assert_eq!(
            results.get(&replacement).and_then(|result| result.state),
            Some(BackgroundProcessState::Unconfirmed)
        );
        assert_eq!(
            results
                .get(&replacement)
                .and_then(|result| result.previous_parent_pid),
            None
        );
    }
}
