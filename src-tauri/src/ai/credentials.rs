use super::types::AiError;
use std::collections::HashMap;

const SERVICE: &str = "com.corerobin.ai";
#[derive(Default)]
pub struct Credentials {
    temporary: HashMap<String, String>,
}

/// Capture only the in-memory value or owned keyring identifier while holding
/// the runtime lock. Resolving a persistent entry must happen off that lock.
pub enum CredentialLookup {
    Memory(Option<String>),
    Persistent(String),
    #[cfg(test)]
    Blocked {
        started: std::sync::Arc<std::sync::atomic::AtomicBool>,
        release: std::sync::mpsc::Receiver<()>,
        value: String,
    },
}
impl CredentialLookup {
    pub fn requires_system_store(&self) -> bool {
        !matches!(self, Self::Memory(_))
    }
    pub fn resolve(self) -> Result<Option<String>, AiError> {
        match self {
            Self::Memory(secret) => Ok(secret),
            Self::Persistent(id) => Credentials::read_persistent(&id).map(Some),
            #[cfg(test)]
            Self::Blocked {
                started,
                release,
                value,
            } => {
                started.store(true, std::sync::atomic::Ordering::Release);
                release.recv().map_err(|_| credential_error())?;
                Ok(Some(value))
            }
        }
    }
}
impl Credentials {
    fn entry(id: &str) -> Result<keyring::Entry, AiError> {
        keyring::Entry::new(SERVICE, id).map_err(|_| credential_error())
    }
    pub fn lookup(&self, id: &str, status: &str) -> CredentialLookup {
        if let Some(secret) = self.temporary.get(id) {
            return CredentialLookup::Memory(Some(secret.clone()));
        }
        if status == "saved" {
            CredentialLookup::Persistent(id.into())
        } else {
            CredentialLookup::Memory(None)
        }
    }
    pub fn validate(secret: &str) -> Result<(), AiError> {
        if secret.is_empty() || secret.len() > 8192 || secret.chars().any(char::is_control) {
            return Err(AiError::new(
                "invalid_credential",
                "Enter a valid credential without line breaks.",
            ));
        }
        Ok(())
    }
    pub fn write_persistent(id: &str, secret: &str) -> Result<(), AiError> {
        Self::validate(secret)?;
        Self::entry(id)?
            .set_password(secret)
            .map_err(|_| credential_error())
    }
    pub fn delete_persistent(id: &str) -> Result<(), AiError> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(credential_error()),
        }
    }
    pub fn remember_temporary(&mut self, id: &str, secret: String) {
        self.temporary.insert(id.into(), secret);
    }
    pub fn forget_temporary(&mut self, id: &str) {
        self.temporary.remove(id);
    }
    fn read_persistent(id: &str) -> Result<String, AiError> {
        match Self::entry(id)?.get_password() {
            Ok(secret) => Ok(secret),
            Err(keyring::Error::NoEntry) => Err(AiError::new(
                "credential_missing",
                "The saved credential is unavailable. Set it again in AI settings.",
            )),
            Err(_) => Err(credential_error()),
        }
    }
    #[cfg(test)]
    pub fn get(&self, id: &str, status: &str) -> Result<Option<String>, AiError> {
        self.lookup(id, status).resolve()
    }
}
fn credential_error() -> AiError {
    AiError::new(
        "credential_store_unavailable",
        "The system credential store is unavailable. Unlock or configure it, or explicitly use a temporary credential. Credentials are never saved as plain text.",
    )
}

#[cfg(test)]
mod system_store_smoke {
    use super::*;

    #[test]
    #[ignore = "Explicit local verification only: briefly creates and deletes a unique synthetic OS credential"]
    fn system_keyring_round_trip_and_removal() {
        let id = format!(
            "synthetic-smoke-{}-{}",
            std::process::id(),
            super::super::service::now()
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = Credentials::delete_persistent(&self.0);
            }
        }
        let _cleanup = Cleanup(id.clone());
        let synthetic = "CoreRobin local synthetic credential; not an API key";
        Credentials::write_persistent(&id, synthetic).expect("OS credential write");
        assert!(Credentials::read_persistent(&id).is_ok_and(|value| value == synthetic));
        Credentials::delete_persistent(&id).expect("OS credential removal");
        assert_eq!(
            Credentials::read_persistent(&id).unwrap_err().code,
            "credential_missing"
        );
    }
}
