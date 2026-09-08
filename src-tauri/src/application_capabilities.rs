//! Shared application results. Model summaries are projections of these data,
//! never the authoritative data that a feature page consumes.
use crate::{error::CommandError, models::NetworkQualityResult};
use serde::Serialize;
use std::sync::{Arc, Mutex};

pub const CHANGED_EVENT: &str = "core-robin:application-capability-changed";
type Notifier = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationCapabilityState {
    pub disk_revision: u64,
    pub disk_requires_rescan: bool,
    pub network_revision: u64,
    pub network: Option<NetworkQualityResult>,
}

#[derive(Default)]
pub struct ApplicationResults {
    state: Mutex<ApplicationCapabilityState>,
    notifier: Mutex<Option<Notifier>>,
}

impl ApplicationResults {
    pub fn set_notifier(&self, notifier: Notifier) {
        if let Ok(mut slot) = self.notifier.lock() {
            *slot = Some(notifier);
        }
    }
    fn notify(&self, capability: &str) {
        let callback = self.notifier.lock().ok().and_then(|slot| slot.clone());
        if let Some(callback) = callback {
            callback(capability);
        }
    }
    pub fn quick_clean_changed(&self) {
        self.notify("quick_clean");
    }
    pub fn snapshot(&self) -> Result<ApplicationCapabilityState, CommandError> {
        self.state
            .lock()
            .map(|state| state.clone())
            .map_err(|_| CommandError::internal("Application result state is unavailable."))
    }
    pub fn disk_changed(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.disk_revision = state.disk_revision.saturating_add(1);
            state.disk_requires_rescan = false;
        }
        self.notify("disk");
    }
    pub fn disk_invalidated(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.disk_revision = state.disk_revision.saturating_add(1);
            state.disk_requires_rescan = true;
        }
        self.notify("disk");
    }
    pub fn publish_network(&self, result: NetworkQualityResult) -> Result<(), CommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("Application result state is unavailable."))?;
        // A slow older check must not replace a newer observation.
        if state
            .network
            .as_ref()
            .is_some_and(|current| current.sampled_at_ms >= result.sampled_at_ms)
        {
            return Ok(());
        }
        state.network = Some(result);
        state.network_revision = state.network_revision.saturating_add(1);
        drop(state);
        self.notify("network");
        Ok(())
    }
    pub fn clear_network(&self) -> Result<(), CommandError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("Application result state is unavailable."))?;
        state.network = None;
        state.network_revision = state.network_revision.saturating_add(1);
        drop(state);
        self.notify("network");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn network(sampled_at_ms: u64) -> NetworkQualityResult {
        NetworkQualityResult {
            sampled_at_ms,
            route_signature: None,
            target_host: "fixture".into(),
            target_port: 443,
            target_count: 1,
            successful_target_count: 1,
            status: crate::models::NetworkQualityStatus::Online,
            dns_available: true,
            dns_lookup_ms: Some(1),
            resolved_address_count: 1,
            probe_count: 1,
            successful_probe_count: 1,
            average_latency_ms: Some(2.0),
            minimum_latency_ms: Some(2.0),
            maximum_latency_ms: Some(2.0),
            jitter_ms: Some(0.0),
            tcp_probe_failure_percent: 0.0,
            diagnostics: vec![],
        }
    }
    #[test]
    fn only_new_observations_notify_and_callbacks_can_read_the_committed_result() {
        let store = Arc::new(ApplicationResults::default());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let weak = Arc::downgrade(&store);
        let output = captured.clone();
        store.set_notifier(Arc::new(move |kind| {
            let snapshot = weak.upgrade().unwrap().snapshot().unwrap();
            output
                .lock()
                .unwrap()
                .push((kind.to_owned(), snapshot.network_revision));
        }));
        store.publish_network(network(200)).unwrap();
        store.publish_network(network(100)).unwrap();
        store.publish_network(network(200)).unwrap();
        assert_eq!(
            store.snapshot().unwrap().network.unwrap().sampled_at_ms,
            200
        );
        assert_eq!(captured.lock().unwrap().len(), 1);
        store.clear_network().unwrap();
        assert!(store.snapshot().unwrap().network.is_none());
        assert_eq!(captured.lock().unwrap()[1], ("network".into(), 2));
    }
    #[test]
    fn unsuccessful_index_reconciliation_requires_a_fresh_result() {
        let store = ApplicationResults::default();
        store.disk_invalidated();
        assert!(store.snapshot().unwrap().disk_requires_rescan);
        store.disk_changed();
        let state = store.snapshot().unwrap();
        assert!(!state.disk_requires_rescan);
        assert_eq!(state.disk_revision, 2);
    }
}
