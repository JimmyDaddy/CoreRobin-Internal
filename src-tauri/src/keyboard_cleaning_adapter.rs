//! Parent-side bridge for the optional keyboard-cleaning helper.
//!
//! This adapter owns only the helper process and its bounded control pipe. It
//! never receives keyboard payloads: helper signals contain lifecycle facts
//! and opaque heartbeat counters only. The helper remains the owner of the
//! event tap and its hard release deadline.

use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

use tauri::{AppHandle, Emitter};

use crate::error::CommandError;
use crate::keyboard_cleaning::{
    self, Capability, HeartbeatCommand, HelperCommand, HelperSignal, HookFailure,
    HookIneffectiveSignal, MAX_FRAME_BYTES, PROTOCOL_VERSION, ReleasedSignal, StartCommand,
    StopCommand, decode_signal, encode_command,
};

pub(crate) const KEYBOARD_CLEANING_EVENT: &str = "core-robin:keyboard-cleaning";

struct ChildSession {
    child: Child,
    stdin: ChildStdin,
    request_id: String,
}

pub(crate) struct KeyboardCleaningAdapter {
    capability: Capability,
    session: Option<ChildSession>,
}

impl KeyboardCleaningAdapter {
    pub(crate) fn new() -> Self {
        Self {
            capability: keyboard_cleaning::helper_capability(),
            session: None,
        }
    }

    pub(crate) const fn capability(&self) -> Capability {
        self.capability
    }

    pub(crate) fn start(
        &mut self,
        app: &AppHandle,
        request: StartCommand,
    ) -> Result<(), CommandError> {
        self.reap_finished()?;
        validate_start(&request, self.capability)?;
        if self.session.is_some() {
            return Err(CommandError::new(
                "keyboard_cleaning_active",
                "A keyboard cleaning helper is already running.",
            ));
        }

        let executable = std::env::current_exe().map_err(|error| {
            CommandError::internal(format!(
                "keyboard helper executable is unavailable: {error}"
            ))
        })?;
        let mut child = Command::new(executable)
            .arg("--keyboard-helper")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                CommandError::internal(format!("keyboard helper could not start: {error}"))
            })?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CommandError::internal(
                "keyboard helper did not expose a control pipe",
            ));
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CommandError::internal(
                "keyboard helper did not expose a signal pipe",
            ));
        };

        let request_id = request.request_id.clone();
        spawn_signal_reader(app.clone(), stdout, request_id.clone());
        let mut session = ChildSession {
            child,
            stdin,
            request_id,
        };
        if let Err(error) = write_command(&mut session.stdin, HelperCommand::Start(request)) {
            let _ = session.child.kill();
            let _ = session.child.wait();
            return Err(error);
        }
        self.session = Some(session);
        Ok(())
    }

    pub(crate) fn heartbeat(&mut self, request: HeartbeatCommand) -> Result<(), CommandError> {
        self.reap_finished()?;
        let Some(session) = self.session.as_mut() else {
            return Err(CommandError::new(
                "keyboard_cleaning_not_running",
                "No keyboard cleaning helper is running.",
            ));
        };
        if request.protocol_version != PROTOCOL_VERSION || request.request_id != session.request_id
        {
            return Err(CommandError::new(
                "keyboard_cleaning_request_mismatch",
                "The heartbeat does not belong to the active keyboard cleaning session.",
            ));
        }
        write_command(&mut session.stdin, HelperCommand::Heartbeat(request))
    }

    pub(crate) fn stop(&mut self, request: StopCommand) -> Result<(), CommandError> {
        self.reap_finished()?;
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if request.protocol_version != PROTOCOL_VERSION || request.request_id != session.request_id
        {
            return Err(CommandError::new(
                "keyboard_cleaning_request_mismatch",
                "The stop request does not belong to the active keyboard cleaning session.",
            ));
        }
        write_command(&mut session.stdin, HelperCommand::Stop(request))
    }

    pub(crate) fn stop_for_reason(
        &mut self,
        reason: keyboard_cleaning::HelperStopReason,
    ) -> Result<(), CommandError> {
        let Some(session) = self.session.as_ref() else {
            return Ok(());
        };
        self.stop(StopCommand {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: session.request_id.clone(),
            reason,
        })
    }

    pub(crate) fn shutdown(&mut self) {
        if let Some(mut session) = self.session.take() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }

    fn reap_finished(&mut self) -> Result<(), CommandError> {
        let finished = self
            .session
            .as_mut()
            .map(|session| session.child.try_wait())
            .transpose()
            .map_err(|error| {
                CommandError::internal(format!("keyboard helper status could not be read: {error}"))
            })?
            .flatten()
            .is_some();
        if finished {
            self.session = None;
        }
        Ok(())
    }
}

impl Drop for KeyboardCleaningAdapter {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate_start(request: &StartCommand, capability: Capability) -> Result<(), CommandError> {
    if !capability.is_available() {
        return Err(CommandError::new(
            "keyboard_cleaning_unavailable",
            "The restricted keyboard helper is unavailable on this platform.",
        ));
    }
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(CommandError::new(
            "keyboard_cleaning_protocol_mismatch",
            "The keyboard helper protocol version is not supported.",
        ));
    }
    if !keyboard_cleaning::ALLOWED_DURATION_SECONDS.contains(&request.duration_seconds)
        || request.hard_deadline_ms < request.prepare_deadline_ms
    {
        return Err(CommandError::new(
            "keyboard_cleaning_invalid_request",
            "The keyboard helper request has an invalid duration or deadline.",
        ));
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        return Err(CommandError::new(
            "keyboard_cleaning_invalid_request",
            "The keyboard helper request identifier is invalid.",
        ));
    }
    Ok(())
}

fn write_command(stdin: &mut ChildStdin, command: HelperCommand) -> Result<(), CommandError> {
    let frame = encode_command(&command).map_err(|error| {
        CommandError::internal(format!(
            "keyboard helper command could not be encoded: {error}"
        ))
    })?;
    stdin.write_all(&frame).map_err(|error| {
        CommandError::new(
            "keyboard_cleaning_disconnected",
            format!("keyboard helper control pipe closed: {error}"),
        )
    })?;
    stdin.write_all(b"\n").map_err(|error| {
        CommandError::new(
            "keyboard_cleaning_disconnected",
            format!("keyboard helper control pipe closed: {error}"),
        )
    })?;
    stdin.flush().map_err(|error| {
        CommandError::new(
            "keyboard_cleaning_disconnected",
            format!("keyboard helper control pipe could not flush: {error}"),
        )
    })
}

fn spawn_signal_reader(app: AppHandle, stdout: impl io::Read + Send + 'static, request_id: String) {
    thread::Builder::new()
        .name("core-robin-keyboard-helper-reader".to_owned())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let released = Arc::new(AtomicBool::new(false));
            loop {
                match read_frame(&mut reader) {
                    Ok(Some(frame)) => match decode_signal(&frame) {
                        Ok(signal) => {
                            if matches!(signal, HelperSignal::Released(_)) {
                                released.store(true, Ordering::Release);
                            }
                            let _ = app.emit_to("main", KEYBOARD_CLEANING_EVENT, signal);
                        }
                        Err(_) => {
                            emit_disconnect(&app, &request_id, &released);
                            return;
                        }
                    },
                    Ok(None) | Err(_) => {
                        if !released.load(Ordering::Acquire) {
                            emit_disconnect(&app, &request_id, &released);
                        }
                        return;
                    }
                }
            }
        })
        .ok();
}

fn emit_disconnect(app: &AppHandle, request_id: &str, released: &AtomicBool) {
    if released.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = app.emit_to(
        "main",
        KEYBOARD_CLEANING_EVENT,
        HelperSignal::HookIneffective(HookIneffectiveSignal {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request_id.to_owned(),
            failure: HookFailure::HostDisconnected,
        }),
    );
    let _ = app.emit_to(
        "main",
        KEYBOARD_CLEANING_EVENT,
        HelperSignal::Released(ReleasedSignal {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: request_id.to_owned(),
            confirmed: false,
        }),
    );
}

fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>, ()> {
    let mut frame = Vec::with_capacity(MAX_FRAME_BYTES);
    loop {
        let buffer = reader.fill_buf().map_err(|_| ())?;
        if buffer.is_empty() {
            return if frame.is_empty() { Ok(None) } else { Err(()) };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.unwrap_or(buffer.len());
        if frame.len() + consumed > MAX_FRAME_BYTES {
            reader.consume(consumed);
            return Err(());
        }
        frame.extend_from_slice(&buffer[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(frame));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_helper_requests_before_spawning() {
        let error = validate_start(
            &StartCommand {
                protocol_version: PROTOCOL_VERSION.to_owned(),
                request_id: "bad id".to_owned(),
                duration_seconds: 30,
                prepare_deadline_ms: 3_000,
                hard_deadline_ms: 180_000,
            },
            Capability::Available,
        )
        .expect_err("spaces are not valid request identifiers");
        assert_eq!(error.code, "keyboard_cleaning_invalid_request");
    }

    #[test]
    fn parent_frame_reader_is_bounded_and_requires_newline() {
        assert!(read_frame(&mut BufReader::new(&b"{}"[..])).is_err());
        let oversized = vec![b'a'; MAX_FRAME_BYTES + 2];
        assert!(read_frame(&mut BufReader::new(&oversized[..])).is_err());
    }
}
