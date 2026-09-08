//! Native logind/elogind notifications. This deliberately does not use window
//! focus as a session-lock signal or claim support for desktops without logind.

use std::{
    collections::HashMap,
    sync::mpsc,
    thread::{self, JoinHandle},
    time::Duration,
};

use futures_lite::StreamExt;
use tokio::sync::oneshot;
use zbus::{
    Connection, MatchRule, MessageStream,
    connection::Builder,
    message::{Message, Type},
    zvariant::{OwnedObjectPath, OwnedValue},
};

use super::{PowerEvent, PowerEventCallbacks};

const LOGIN_SERVICE: &str = "org.freedesktop.login1";
const MANAGER_PATH: &str = "/org/freedesktop/login1";
const MANAGER_INTERFACE: &str = "org.freedesktop.login1.Manager";
const SESSION_INTERFACE: &str = "org.freedesktop.login1.Session";
const PROPERTIES_INTERFACE: &str = "org.freedesktop.DBus.Properties";
const DBUS_SERVICE: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
const METHOD_TIMEOUT: Duration = Duration::from_secs(2);
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_TIMEOUT: Duration = Duration::from_millis(200);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(750);

pub(super) struct LinuxPowerEventObserver {
    stop: Option<oneshot::Sender<()>>,
    completed: mpsc::Receiver<()>,
    worker: Option<JoinHandle<()>>,
}

impl LinuxPowerEventObserver {
    pub(super) fn register(callbacks: PowerEventCallbacks) -> Result<Self, String> {
        // Until the first subscribed snapshot is known, invalidate sensitive
        // presentation once. Recovery never reopens it automatically.
        callbacks.dispatch(PowerEvent::SessionInactive);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("create Linux power observer runtime: {error}"))?;
        let (stop, receiver) = oneshot::channel();
        let (completed, completion) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("core-robin-power-events".into())
            .spawn(move || {
                runtime.block_on(supervise(callbacks, receiver));
                runtime.shutdown_timeout(CLOSE_TIMEOUT);
                let _ = completed.send(());
            })
            .map_err(|error| format!("start Linux power observer: {error}"))?;
        Ok(Self {
            stop: Some(stop),
            completed: completion,
            worker: Some(worker),
        })
    }
}

impl Drop for LinuxPowerEventObserver {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // A stuck bus or an OS scheduling delay must not block the event loop
        // indefinitely. The worker closes its dedicated connection on shutdown,
        // which removes every match registration, before reporting completion.
        let finished = self.completed.recv_timeout(SHUTDOWN_TIMEOUT).is_ok();
        if let Some(worker) = self.worker.take() {
            if worker.is_finished() {
                let _ = worker.join();
            } else if !finished {
                eprintln!("Linux power observer exceeded its shutdown deadline");
            }
        }
    }
}

async fn supervise(callbacks: PowerEventCallbacks, mut stop: oneshot::Receiver<()>) {
    let mut unavailable = true;
    let mut retry_delay = Duration::from_secs(1);
    loop {
        let mut reached_ready = false;
        let result =
            observe_once(&callbacks, &mut stop, &mut unavailable, &mut reached_ready).await;
        let Err(error) = result else {
            return;
        };
        if !unavailable {
            callbacks.dispatch(PowerEvent::SessionInactive);
            unavailable = true;
        }
        if reached_ready {
            retry_delay = Duration::from_secs(1);
        }
        eprintln!(
            "Linux power/session observation unavailable: {error}; retrying in {}s",
            retry_delay.as_secs()
        );
        tokio::select! {
            biased;
            _ = &mut stop => return,
            _ = tokio::time::sleep(retry_delay) => {}
        }
        retry_delay = (retry_delay * 2).min(Duration::from_secs(30));
    }
}

async fn observe_once(
    callbacks: &PowerEventCallbacks,
    stop: &mut oneshot::Receiver<()>,
    unavailable: &mut bool,
    reached_ready: &mut bool,
) -> Result<(), String> {
    let connection = tokio::select! {
        biased;
        _ = &mut *stop => return Ok(()),
        result = tokio::time::timeout(SETUP_TIMEOUT, async {
            Builder::system()?.method_timeout(METHOD_TIMEOUT).build().await
        }) => result.map_err(|_| "system bus connection timed out".to_string())?
            .map_err(|error| format!("connect to system bus: {error}"))?,
    };
    let result = tokio::select! {
        biased;
        _ = &mut *stop => Ok(()),
        result = observe_connection(&connection, callbacks, unavailable, reached_ready) => result,
    };
    // Closing the dedicated bus socket also removes all bus-side match rules.
    // Do not await unbounded graceful_shutdown or a blocking signal iterator.
    match tokio::time::timeout(CLOSE_TIMEOUT, connection.close()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Linux power observer bus close failed: {error}"),
        Err(_) => eprintln!("Linux power observer bus close timed out"),
    }
    result
}

struct Subscription {
    owner: String,
    session_path: OwnedObjectPath,
    signals: MessageStream,
    owners: MessageStream,
    initial_sleep: bool,
    initial_session: SessionState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionState {
    locked: bool,
    active: bool,
}

impl SessionState {
    fn inactive(self) -> bool {
        self.locked || !self.active
    }
}

async fn subscribe(connection: &Connection) -> Result<Subscription, String> {
    // Subscribe to owner changes before resolving the owner, so a logind restart
    // during setup cannot leave a live subscription to an obsolete service.
    let owners = MessageStream::for_match_rule(
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(DBUS_SERVICE)
            .map_err(dbus_error)?
            .path(DBUS_PATH)
            .map_err(dbus_error)?
            .interface(DBUS_SERVICE)
            .map_err(dbus_error)?
            .member("NameOwnerChanged")
            .map_err(dbus_error)?
            .add_arg(LOGIN_SERVICE)
            .map_err(dbus_error)?
            .build(),
        connection,
        Some(16),
    )
    .await
    .map_err(dbus_error)?;
    let owner: String = connection
        .call_method(
            Some(DBUS_SERVICE),
            DBUS_PATH,
            Some(DBUS_SERVICE),
            "GetNameOwner",
            &(LOGIN_SERVICE,),
        )
        .await
        .map_err(dbus_error)?
        .body()
        .deserialize()
        .map_err(dbus_error)?;
    // One ordered stream preserves sleep/wake ordering. Its bus-side sender and
    // namespace filters are narrowed again to the exact current session below.
    let signals = MessageStream::for_match_rule(
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(owner.as_str())
            .map_err(dbus_error)?
            .path_namespace(MANAGER_PATH)
            .map_err(dbus_error)?
            .build(),
        connection,
        Some(256),
    )
    .await
    .map_err(dbus_error)?;
    let session_path = resolve_session(connection, &owner).await?;
    // Both signal subscriptions precede these uncached property reads. Any
    // concurrent lock/sleep transition remains queued and is handled next.
    let initial_sleep = read_bool_property(
        connection,
        &owner,
        MANAGER_PATH,
        MANAGER_INTERFACE,
        "PreparingForSleep",
    )
    .await?;
    let initial_session = read_session(connection, &owner, session_path.as_str()).await?;
    Ok(Subscription {
        owner,
        session_path,
        signals,
        owners,
        initial_sleep,
        initial_session,
    })
}

async fn observe_connection(
    connection: &Connection,
    callbacks: &PowerEventCallbacks,
    unavailable: &mut bool,
    reached_ready: &mut bool,
) -> Result<(), String> {
    let mut subscription = tokio::time::timeout(SETUP_TIMEOUT, subscribe(connection))
        .await
        .map_err(|_| "logind subscription or initial state query timed out".to_string())??;
    *unavailable = false;
    *reached_ready = true;
    if subscription.initial_sleep {
        callbacks.dispatch(PowerEvent::Sleep);
    }
    if subscription.initial_session.inactive() {
        callbacks.dispatch(PowerEvent::SessionInactive);
    }
    loop {
        tokio::select! {
            result = subscription.owners.next() => {
                let message = stream_message(result)?;
                if owner_changed(&message, &subscription.owner)? {
                    return Err("logind service owner changed".into());
                }
            }
            result = subscription.signals.next() => {
                let message = stream_message(result)?;
                match classify_signal(&message, &subscription.owner, subscription.session_path.as_str())? {
                    Action::Ignore => {}
                    Action::Sleep => callbacks.dispatch(PowerEvent::Sleep),
                    Action::Wake => callbacks.dispatch(PowerEvent::Wake),
                    Action::SessionInactive => callbacks.dispatch(PowerEvent::SessionInactive),
                    Action::SessionRemoved => return Err("current logind session was removed".into()),
                    Action::RefreshSession => {
                        // Invalidated properties make the state unknown. Hide
                        // before the round trip, even if it later reports active.
                        callbacks.dispatch(PowerEvent::SessionInactive);
                        let _ = read_session(connection, &subscription.owner, subscription.session_path.as_str()).await?;
                    }
                }
            }
        }
    }
}

async fn resolve_session(connection: &Connection, owner: &str) -> Result<OwnedObjectPath, String> {
    let session_id = std::env::var("XDG_SESSION_ID").ok();
    resolve_session_with(session_id.as_deref(), |lookup| async move {
        let reply = match lookup {
            SessionLookup::Process => {
                connection
                    .call_method(
                        Some(owner),
                        MANAGER_PATH,
                        Some(MANAGER_INTERFACE),
                        "GetSessionByPID",
                        &(std::process::id(),),
                    )
                    .await
            }
            SessionLookup::Named(id) => {
                connection
                    .call_method(
                        Some(owner),
                        MANAGER_PATH,
                        Some(MANAGER_INTERFACE),
                        "GetSession",
                        &(id,),
                    )
                    .await
            }
        }
        .map_err(dbus_error)?;
        reply.body().deserialize().map_err(dbus_error)
    })
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionLookup<'a> {
    Process,
    Named(&'a str),
}

async fn resolve_session_with<'a, Lookup, Reply>(
    session_id: Option<&'a str>,
    mut lookup: Lookup,
) -> Result<OwnedObjectPath, String>
where
    Lookup: FnMut(SessionLookup<'a>) -> Reply,
    Reply: std::future::Future<Output = Result<OwnedObjectPath, String>>,
{
    // systemd-user/D-Bus launches may have neither a PID-associated session nor
    // XDG_SESSION_ID. GetSession("auto") then resolves the caller's own session
    // or its owning user's display session; only its concrete result is used.
    let attempts = std::iter::once(SessionLookup::Process)
        .chain(
            session_id
                .filter(|id| !id.trim().is_empty())
                .map(SessionLookup::Named),
        )
        .chain(std::iter::once(SessionLookup::Named("auto")));
    let mut last_error = String::new();
    for attempt in attempts {
        match lookup(attempt).await {
            Ok(path) if concrete_session_path(path.as_str()) => return Ok(path),
            Ok(_) => {
                last_error = "logind returned a session alias instead of a concrete path".into()
            }
            Err(error) => last_error = error,
        }
    }
    Err(format!("resolve current logind session: {last_error}"))
}

fn concrete_session_path(path: &str) -> bool {
    path.strip_prefix("/org/freedesktop/login1/session/")
        .is_some_and(|id| !id.is_empty() && !id.contains('/') && id != "self" && id != "auto")
}

async fn read_bool_property(
    connection: &Connection,
    owner: &str,
    path: &str,
    interface: &str,
    property: &str,
) -> Result<bool, String> {
    let value: OwnedValue = connection
        .call_method(
            Some(owner),
            path,
            Some(PROPERTIES_INTERFACE),
            "Get",
            &(interface, property),
        )
        .await
        .map_err(dbus_error)?
        .body()
        .deserialize()
        .map_err(dbus_error)?;
    bool::try_from(&value).map_err(|error| format!("invalid logind {property}: {error}"))
}

async fn read_session(
    connection: &Connection,
    owner: &str,
    path: &str,
) -> Result<SessionState, String> {
    let properties: HashMap<String, OwnedValue> = connection
        .call_method(
            Some(owner),
            path,
            Some(PROPERTIES_INTERFACE),
            "GetAll",
            &(SESSION_INTERFACE,),
        )
        .await
        .map_err(dbus_error)?
        .body()
        .deserialize()
        .map_err(dbus_error)?;
    Ok(SessionState {
        locked: bool_property(&properties, "LockedHint")?
            .ok_or("logind session omitted LockedHint")?,
        active: bool_property(&properties, "Active")?.ok_or("logind session omitted Active")?,
    })
}

fn dbus_error(error: zbus::Error) -> String {
    format!("logind D-Bus error: {error}")
}

fn stream_message(message: Option<zbus::Result<Message>>) -> Result<Message, String> {
    message
        .ok_or_else(|| "logind signal stream closed".to_string())?
        .map_err(dbus_error)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Ignore,
    Sleep,
    Wake,
    SessionInactive,
    SessionRemoved,
    RefreshSession,
}

fn owner_changed(message: &Message, owner: &str) -> Result<bool, String> {
    let header = message.header();
    if message.message_type() != Type::Signal
        || header.sender().map(|value| value.as_str()) != Some(DBUS_SERVICE)
        || header.path().map(|value| value.as_str()) != Some(DBUS_PATH)
        || header.interface().map(|value| value.as_str()) != Some(DBUS_SERVICE)
        || header.member().map(|value| value.as_str()) != Some("NameOwnerChanged")
    {
        return Ok(false);
    }
    let (name, _previous, current): (String, String, String) =
        message.body().deserialize().map_err(dbus_error)?;
    Ok(name == LOGIN_SERVICE && current != owner)
}

fn classify_signal(message: &Message, owner: &str, session: &str) -> Result<Action, String> {
    let header = message.header();
    if message.message_type() != Type::Signal
        || header.sender().map(|value| value.as_str()) != Some(owner)
    {
        return Ok(Action::Ignore);
    }
    let path = header.path().map(|value| value.as_str());
    let interface = header.interface().map(|value| value.as_str());
    let member = header.member().map(|value| value.as_str());
    if path == Some(MANAGER_PATH) && interface == Some(MANAGER_INTERFACE) {
        return match member {
            Some("PrepareForSleep") => {
                let (sleeping,): (bool,) = message.body().deserialize().map_err(dbus_error)?;
                Ok(if sleeping {
                    Action::Sleep
                } else {
                    Action::Wake
                })
            }
            Some("SessionRemoved") => {
                let (_, removed): (String, OwnedObjectPath) =
                    message.body().deserialize().map_err(dbus_error)?;
                Ok(if removed.as_str() == session {
                    Action::SessionRemoved
                } else {
                    Action::Ignore
                })
            }
            _ => Ok(Action::Ignore),
        };
    }
    // Never react to another user's session, an alias object, or an unrelated
    // interface that happens to emit an identically named signal/property.
    if path != Some(session) {
        return Ok(Action::Ignore);
    }
    if interface == Some(SESSION_INTERFACE) && member == Some("Lock") {
        message.body().deserialize::<()>().map_err(dbus_error)?;
        return Ok(Action::SessionInactive);
    }
    if interface == Some(PROPERTIES_INTERFACE) && member == Some("PropertiesChanged") {
        let (changed_interface, changed, invalidated): (
            String,
            HashMap<String, OwnedValue>,
            Vec<String>,
        ) = message.body().deserialize().map_err(dbus_error)?;
        if changed_interface != SESSION_INTERFACE {
            return Ok(Action::Ignore);
        }
        return classify_properties(&changed, &invalidated);
    }
    Ok(Action::Ignore)
}

fn bool_property(
    properties: &HashMap<String, OwnedValue>,
    name: &str,
) -> Result<Option<bool>, String> {
    properties
        .get(name)
        .map(|value| {
            bool::try_from(value).map_err(|error| format!("invalid logind {name}: {error}"))
        })
        .transpose()
}

fn classify_properties(
    changed: &HashMap<String, OwnedValue>,
    invalidated: &[String],
) -> Result<Action, String> {
    let locked = bool_property(changed, "LockedHint")?;
    let active = bool_property(changed, "Active")?;
    if locked == Some(true) || active == Some(false) {
        return Ok(Action::SessionInactive);
    }
    if invalidated
        .iter()
        .any(|name| name == "LockedHint" || name == "Active")
    {
        return Ok(Action::RefreshSession);
    }
    // Unlock/activation is not permission to reveal a previous presentation.
    Ok(Action::Ignore)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = ":1.42";
    const SESSION: &str = "/org/freedesktop/login1/session/_32";

    fn signal(path: &str, interface: &str, member: &str) -> zbus::message::Builder<'static> {
        Message::signal(path.to_string(), interface.to_string(), member.to_string())
            .unwrap()
            .sender(OWNER)
            .unwrap()
    }

    #[test]
    fn sleep_and_wake_use_the_manager_boolean() {
        for (sleeping, expected) in [(true, Action::Sleep), (false, Action::Wake)] {
            let message = signal(MANAGER_PATH, MANAGER_INTERFACE, "PrepareForSleep")
                .build(&(sleeping,))
                .unwrap();
            assert_eq!(classify_signal(&message, OWNER, SESSION).unwrap(), expected);
        }
    }

    #[test]
    fn only_current_session_lock_is_observed() {
        for (path, expected) in [
            (SESSION, Action::SessionInactive),
            ("/org/freedesktop/login1/session/_39", Action::Ignore),
            ("/org/freedesktop/login1/session/self", Action::Ignore),
        ] {
            let message = signal(path, SESSION_INTERFACE, "Lock").build(&()).unwrap();
            assert_eq!(classify_signal(&message, OWNER, SESSION).unwrap(), expected);
        }
        let message = signal(SESSION, SESSION_INTERFACE, "Lock")
            .build(&())
            .unwrap();
        assert_eq!(
            classify_signal(&message, ":1.43", SESSION).unwrap(),
            Action::Ignore
        );
    }

    #[test]
    fn locked_hint_and_session_switch_both_hide() {
        for (name, value, expected) in [
            ("LockedHint", true, Action::SessionInactive),
            ("Active", false, Action::SessionInactive),
            ("LockedHint", false, Action::Ignore),
            ("Active", true, Action::Ignore),
            ("IdleHint", true, Action::Ignore),
        ] {
            let changed = HashMap::from([(name.to_string(), OwnedValue::from(value))]);
            let message = signal(SESSION, PROPERTIES_INTERFACE, "PropertiesChanged")
                .build(&(SESSION_INTERFACE, changed, Vec::<String>::new()))
                .unwrap();
            assert_eq!(classify_signal(&message, OWNER, SESSION).unwrap(), expected);
        }
    }

    #[test]
    fn unrelated_interface_or_session_properties_are_ignored() {
        for (path, interface) in [
            (SESSION, "org.example.Other"),
            ("/org/freedesktop/login1/session/_39", SESSION_INTERFACE),
        ] {
            let changed = HashMap::from([("LockedHint".to_string(), OwnedValue::from(true))]);
            let message = signal(path, PROPERTIES_INTERFACE, "PropertiesChanged")
                .build(&(interface, changed, Vec::<String>::new()))
                .unwrap();
            assert_eq!(
                classify_signal(&message, OWNER, SESSION).unwrap(),
                Action::Ignore
            );
        }
    }

    #[test]
    fn invalidated_sensitive_properties_require_a_fresh_snapshot() {
        for name in ["LockedHint", "Active"] {
            assert_eq!(
                classify_properties(&HashMap::new(), &[name.to_string()]).unwrap(),
                Action::RefreshSession,
            );
        }
        assert_eq!(
            classify_properties(&HashMap::new(), &["IdleHint".to_string()]).unwrap(),
            Action::Ignore,
        );
        assert!(
            classify_properties(
                &HashMap::from([("LockedHint".to_string(), OwnedValue::from(1_u32))]),
                &[],
            )
            .is_err()
        );
    }

    #[test]
    fn current_session_removal_requires_reconnection() {
        for (removed, expected) in [
            (SESSION, Action::SessionRemoved),
            ("/org/freedesktop/login1/session/_39", Action::Ignore),
        ] {
            let message = signal(MANAGER_PATH, MANAGER_INTERFACE, "SessionRemoved")
                .build(&("2", OwnedObjectPath::try_from(removed).unwrap()))
                .unwrap();
            assert_eq!(classify_signal(&message, OWNER, SESSION).unwrap(), expected);
        }
    }

    #[test]
    fn unlock_does_not_restore_a_hidden_presentation() {
        let message = signal(SESSION, SESSION_INTERFACE, "Unlock")
            .build(&())
            .unwrap();
        assert_eq!(
            classify_signal(&message, OWNER, SESSION).unwrap(),
            Action::Ignore
        );
        assert!(
            !SessionState {
                locked: false,
                active: true
            }
            .inactive()
        );
        assert!(
            SessionState {
                locked: true,
                active: true
            }
            .inactive()
        );
        assert!(
            SessionState {
                locked: false,
                active: false
            }
            .inactive()
        );
    }

    #[test]
    fn session_aliases_are_not_valid_subscription_targets() {
        assert!(concrete_session_path(SESSION));
        for path in [
            "/org/freedesktop/login1/session/self",
            "/org/freedesktop/login1/session/auto",
            "/org/freedesktop/login1/session/",
            "/org/freedesktop/login1/session/_32/child",
            MANAGER_PATH,
        ] {
            assert!(!concrete_session_path(path));
        }
    }

    #[tokio::test]
    async fn auto_resolves_service_launches_after_pid_and_optional_xdg_fail() {
        for session_id in [None, Some("stale-session")] {
            let mut requests = Vec::new();
            let path = resolve_session_with(session_id, |request| {
                requests.push(request);
                std::future::ready(match request {
                    SessionLookup::Named("auto") => Ok(OwnedObjectPath::try_from(SESSION).unwrap()),
                    _ => Err("no such session".into()),
                })
            })
            .await
            .unwrap();
            assert_eq!(path.as_str(), SESSION);
            let expected = match session_id {
                None => vec![SessionLookup::Process, SessionLookup::Named("auto")],
                Some(id) => vec![
                    SessionLookup::Process,
                    SessionLookup::Named(id),
                    SessionLookup::Named("auto"),
                ],
            };
            assert_eq!(requests, expected);
        }
    }

    #[tokio::test]
    async fn session_resolution_stops_after_success_and_rejects_returned_aliases() {
        let mut requests = Vec::new();
        let path = resolve_session_with(Some("other"), |request| {
            requests.push(request);
            std::future::ready(Ok(OwnedObjectPath::try_from(SESSION).unwrap()))
        })
        .await
        .unwrap();
        assert_eq!(path.as_str(), SESSION);
        assert_eq!(requests, vec![SessionLookup::Process]);
        let result = resolve_session_with(None, |_| {
            std::future::ready(Ok(OwnedObjectPath::try_from(
                "/org/freedesktop/login1/session/auto",
            )
            .unwrap()))
        })
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn owner_loss_is_detected_but_queued_initial_acquisition_is_ignored() {
        for (name, current, changed) in [
            (LOGIN_SERVICE, "", true),
            (LOGIN_SERVICE, ":1.43", true),
            (LOGIN_SERVICE, OWNER, false),
            ("org.example.Other", "", false),
        ] {
            let message = Message::signal(DBUS_PATH, DBUS_SERVICE, "NameOwnerChanged")
                .unwrap()
                .sender(DBUS_SERVICE)
                .unwrap()
                .build(&(name, OWNER, current))
                .unwrap();
            assert_eq!(owner_changed(&message, OWNER).unwrap(), changed);
        }
    }
}
