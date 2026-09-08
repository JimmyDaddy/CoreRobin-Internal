//! Bounded, explicitly addressed HTTP. Nothing here reads environment credentials or proxies.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::{Client, Url};

use super::types::{
    AiError, AuthKind, ConnectionProfile, NetworkPolicy, Protocol, ProxyCredential,
};

pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAX_INPUT_BYTES: usize = 32 * 1024;
const CONNECT_SECONDS: u64 = 10;

pub struct Transport {
    pub client: Client,
    pub base_url: Url,
}

fn invalid(message: &str) -> AiError {
    AiError::new("invalid_endpoint", message)
}

pub fn validate_profile(profile: &ConnectionProfile) -> Result<(), AiError> {
    let endpoint = validate_endpoint(&profile.api_base_url, &profile.network_policy)?;
    let generation_path = match profile.protocol {
        Protocol::OllamaNative => "/api/chat",
        Protocol::OpenaiChat => "/chat/completions",
        Protocol::OpenaiResponses => "/responses",
        Protocol::AnthropicMessages => "/messages",
    };
    if endpoint
        .path()
        .trim_end_matches('/')
        .ends_with(generation_path)
    {
        return Err(invalid(
            "This looks like a complete generation URL. Review and confirm its API base prefix in AI settings before saving.",
        ));
    }
    if let Some(proxy) = profile.proxy_url.as_deref().filter(|v| !v.is_empty()) {
        validate_proxy(proxy, profile.proxy_network_policy.as_ref())?;
    }
    if matches!(profile.auth_kind, AuthKind::CustomHeader) {
        custom_auth_header(profile.auth_header_name.as_deref().unwrap_or_default())?;
    }
    if !matches!(
        profile.chat_token_limit_parameter.as_str(),
        "auto" | "max_tokens" | "max_completion_tokens"
    ) {
        return Err(AiError::new(
            "invalid_options",
            "Choose a supported Chat token-limit parameter.",
        ));
    }
    if let Some(workspace) = profile.anthropic_workspace_id.as_deref()
        && (!matches!(profile.protocol, Protocol::AnthropicMessages)
            || workspace.is_empty()
            || workspace.len() > 128
            || !workspace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    {
        return Err(AiError::new(
            "invalid_workspace",
            "Enter a valid Anthropic workspace ID for a Messages connection.",
        ));
    }
    Ok(())
}

pub fn custom_auth_header(raw: &str) -> Result<reqwest::header::HeaderName, AiError> {
    let name = reqwest::header::HeaderName::from_bytes(raw.as_bytes()).map_err(|_| {
        AiError::new(
            "invalid_auth_header",
            "Enter a valid custom authentication header name.",
        )
    })?;
    let reserved = [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "trailer",
        "te",
        "keep-alive",
        "authorization",
        "proxy-authorization",
        "proxy-authenticate",
        "www-authenticate",
        "x-api-key",
        "cookie",
        "set-cookie",
        "content-type",
        "content-encoding",
        "accept",
        "accept-encoding",
        "expect",
        "origin",
        "referer",
        "forwarded",
        "via",
        "range",
    ];
    if raw.len() > 128
        || reserved.contains(&name.as_str())
        || name.as_str().starts_with("anthropic-")
        || name.as_str().starts_with("proxy-")
        || name.as_str().starts_with("sec-")
        || name.as_str().starts_with("x-forwarded-")
    {
        return Err(AiError::new(
            "invalid_auth_header",
            "This header is reserved for HTTP, standard authentication or the selected protocol.",
        ));
    }
    Ok(name)
}

pub fn validate_proxy_credential(credential: &ProxyCredential) -> Result<(), AiError> {
    if credential.username.is_empty()
        || credential.username.len() > 256
        || credential.username.contains(':')
        || credential.username.chars().any(char::is_control)
        || credential.password.is_empty()
        || credential.password.len() > 8192
        || credential.password.chars().any(char::is_control)
    {
        return Err(AiError::new(
            "invalid_proxy_credential",
            "Enter a proxy username and password without control characters.",
        ));
    }
    Ok(())
}

pub fn validate_proxy_auth(
    profile: &ConnectionProfile,
    credential: &ProxyCredential,
) -> Result<(), AiError> {
    validate_proxy_credential(credential)?;
    if matches!(profile.network_policy, NetworkPolicy::Loopback) {
        return Ok(());
    }
    let raw = profile
        .proxy_url
        .as_deref()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            AiError::new(
                "proxy_required",
                "Configure a proxy address before setting its credentials.",
            )
        })?;
    let (proxy, policy) = validate_proxy(raw, profile.proxy_network_policy.as_ref())?;
    if proxy.scheme() != "https" && !matches!(policy, NetworkPolicy::Loopback) {
        return Err(AiError::new(
            "insecure_proxy_auth",
            "A remote proxy with a username and password must use HTTPS. Update its address or remove proxy authentication.",
        ));
    }
    Ok(())
}

/// Pure validation used when saving a connection; does not resolve DNS or contact a service.
pub fn validate_endpoint(raw: &str, policy: &NetworkPolicy) -> Result<Url, AiError> {
    let url = parse_url(raw)?;
    let host = url
        .host_str()
        .ok_or_else(|| invalid("The API address needs a host."))?;
    let literal = parse_ip(host);
    if url.scheme() == "http" && !matches!(policy, NetworkPolicy::Loopback) {
        return Err(invalid(
            "HTTP is allowed only for a loopback service. Use HTTPS for other services.",
        ));
    }
    if let Some(ip) = literal {
        validate_ip(ip, policy)?;
    } else if matches!(policy, NetworkPolicy::Loopback) && !is_localhost(host) {
        return Err(invalid(
            "Loopback connections must use localhost or a loopback IP address.",
        ));
    } else if !matches!(policy, NetworkPolicy::Loopback) && is_localhost(host) {
        return Err(invalid("This host requires the loopback network policy."));
    }
    Ok(url)
}

fn parse_url(raw: &str) -> Result<Url, AiError> {
    if raw.len() > 2048 || raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err(invalid("The API address contains unsupported characters."));
    }
    let url =
        Url::parse(raw).map_err(|_| invalid("Enter an absolute HTTP or HTTPS API address."))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return Err(invalid("Enter an absolute HTTP or HTTPS API address."));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "Keep credentials, query parameters and fragments out of the API address.",
        ));
    }
    Ok(url)
}

fn is_localhost(host: &str) -> bool {
    host.trim_end_matches('.').eq_ignore_ascii_case("localhost")
}

fn parse_ip(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    }
}

fn forbidden_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    ip.is_unspecified() || ip.is_multicast() || ip.is_link_local() || ip.is_broadcast()
        || a == 0 || a >= 240
        // Cloud metadata / platform control addresses outside link-local space.
        || [a, b, c, d] == [100, 100, 100, 200]
        || [a, b, c, d] == [168, 63, 129, 16]
        // Reserved, benchmark, and documentation networks are not model endpoints.
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113)
}

fn forbidden_v6(ip: Ipv6Addr) -> bool {
    let octets = ip.octets();
    ip.is_unspecified() || ip.is_multicast() || ip.is_unicast_link_local()
        || (octets[..4] == [0x20, 0x01, 0x0d, 0xb8])
        // Apart from loopback/ULA, accept only global-unicast allocation space.
        // This also excludes IPv4-translatable and local-use NAT64 forms.
        || (!ip.is_loopback() && !ip.is_unique_local() && octets[0] & 0xe0 != 0x20)
        || (octets[..2] == [0x20, 0x01] && octets[2] < 2)
        // Reject deprecated site-local, IPv4-compatible, NAT64, 6to4 and Teredo
        // forms instead of letting translation hide a forbidden IPv4 destination.
        || (octets[0] == 0xfe && octets[1] & 0xc0 == 0xc0)
        || (!ip.is_loopback() && octets[..12] == [0; 12])
        || octets[..12] == [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]
        || octets[..2] == [0x20, 0x02]
        || octets[..4] == [0x20, 0x01, 0, 0]
}

pub fn validate_ip(ip: IpAddr, policy: &NetworkPolicy) -> Result<(), AiError> {
    let ip = canonical_ip(ip);
    let forbidden = match ip {
        IpAddr::V4(v4) => forbidden_v4(v4),
        IpAddr::V6(v6) => forbidden_v6(v6),
    };
    if forbidden {
        return Err(invalid(
            "The service address resolves to a reserved or prohibited network.",
        ));
    }
    let private = match ip {
        IpAddr::V4(v4) => v4.is_private() || (v4.octets()[0] == 100 && v4.octets()[1] & 0xc0 == 64),
        IpAddr::V6(v6) => v6.is_unique_local(),
    };
    let allowed = match policy {
        NetworkPolicy::Loopback => ip.is_loopback(),
        NetworkPolicy::Private => private && !ip.is_loopback(),
        NetworkPolicy::Public => !private && !ip.is_loopback(),
    };
    if !allowed {
        return Err(invalid(
            "The resolved address does not match the selected network policy.",
        ));
    }
    Ok(())
}

/// Append a protocol-owned relative path while preserving the user-supplied API prefix.
pub fn endpoint_path(base: &Url, suffix: &str) -> Result<Url, AiError> {
    if suffix.is_empty() || suffix.contains("..") || suffix.contains(['?', '#', '\\']) {
        return Err(invalid("Invalid API path."));
    }
    let mut url = base.clone();
    url.set_path(&format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    ));
    Ok(url)
}

async fn resolve(url: &Url, policy: &NetworkPolicy) -> Result<Vec<SocketAddr>, AiError> {
    let host = url
        .host_str()
        .ok_or_else(|| invalid("The API address needs a host."))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| invalid("The API address needs a valid port."))?;
    let mut addresses: Vec<SocketAddr> = if let Some(ip) = parse_ip(host) {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(
            Duration::from_secs(CONNECT_SECONDS),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| {
            AiError::new(
                "dns_failed",
                "Resolving the configured service host timed out.",
            )
        })?
        .map_err(|_| {
            AiError::new(
                "dns_failed",
                "Could not resolve the configured service host.",
            )
        })?
        .take(33)
        .collect()
    };
    if addresses.is_empty() || addresses.len() > 32 {
        return Err(AiError::new(
            "dns_failed",
            "The service returned no usable bounded DNS result.",
        ));
    }
    // Reject mixed answers instead of silently selecting the permitted subset.
    for address in &addresses {
        validate_ip(address.ip(), policy)?;
    }
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}

/// Explicit proxies are separate trusted recipients. Their final target resolution
/// is not observable here and is disclosed in the approved preview by the service.
pub fn validate_proxy(
    raw: &str,
    configured_policy: Option<&NetworkPolicy>,
) -> Result<(Url, NetworkPolicy), AiError> {
    let url = parse_url(raw)?;
    if url.path() != "/" && !url.path().is_empty() {
        return Err(invalid("A proxy address cannot have an API path."));
    }
    let host = url
        .host_str()
        .ok_or_else(|| invalid("The proxy address needs a host."))?;
    let inferred_policy = match parse_ip(host).map(canonical_ip) {
        Some(ip) if ip.is_loopback() => NetworkPolicy::Loopback,
        Some(IpAddr::V4(ip)) if ip.is_private() => NetworkPolicy::Private,
        Some(IpAddr::V6(ip)) if ip.is_unique_local() => NetworkPolicy::Private,
        _ if is_localhost(host) => NetworkPolicy::Loopback,
        _ => NetworkPolicy::Public,
    };
    let policy = configured_policy.unwrap_or(&inferred_policy).clone();
    // HTTP CONNECT to a remote proxy exposes the destination; it does not expose
    // the end-to-end TLS model request. It is nevertheless an explicit recipient.
    if let Some(ip) = parse_ip(host) {
        validate_ip(ip, &policy)?;
    } else if matches!(policy, NetworkPolicy::Loopback) && !is_localhost(host) {
        return Err(invalid(
            "Loopback proxies must use localhost or a loopback IP address.",
        ));
    } else if !matches!(policy, NetworkPolicy::Loopback) && is_localhost(host) {
        return Err(invalid("This proxy requires the loopback network policy."));
    }
    Ok((url, policy))
}

impl Transport {
    pub async fn new(
        profile: &ConnectionProfile,
        proxy_credential: Option<&ProxyCredential>,
    ) -> Result<Self, AiError> {
        if let Some(credential) = proxy_credential {
            validate_proxy_auth(profile, credential)?;
        }
        let base_url = validate_endpoint(&profile.api_base_url, &profile.network_policy)?;
        let mut builder = Client::builder()
            .use_native_tls()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_secs(CONNECT_SECONDS))
            .timeout(Duration::from_secs(profile.timeout_seconds.clamp(10, 300)))
            .pool_max_idle_per_host(0);
        if !matches!(profile.network_policy, NetworkPolicy::Loopback)
            && let Some(raw) = profile.proxy_url.as_deref().filter(|v| !v.is_empty())
        {
            let (proxy_url, proxy_policy) =
                validate_proxy(raw, profile.proxy_network_policy.as_ref())?;
            let proxy_addresses = resolve(&proxy_url, &proxy_policy).await?;
            let mut proxy = reqwest::Proxy::all(proxy_url.as_str())
                .map_err(|_| invalid("Invalid explicit proxy address."))?;
            if let Some(credential) = proxy_credential {
                proxy = proxy.basic_auth(&credential.username, &credential.password);
            }
            builder = builder
                .resolve_to_addrs(proxy_url.host_str().unwrap_or_default(), &proxy_addresses)
                .proxy(proxy);
            // CONNECT keeps the original destination hostname for proxy DNS and
            // end-to-end TLS verification. Only the explicit proxy is locally
            // resolved and pinned; its destination IP is unknown to this client.
        } else {
            let addresses = resolve(&base_url, &profile.network_policy).await?;
            builder = builder.resolve_to_addrs(base_url.host_str().unwrap_or_default(), &addresses);
        }
        let client = builder.build().map_err(|_| {
            AiError::new(
                "transport_unavailable",
                "Could not initialize the system TLS connection.",
            )
        })?;
        Ok(Self { client, base_url })
    }
}

/// Atomic cancellation is checked during DNS, connection and body reads, not only
/// when the service produces the next token. Dropping the future closes the request.
pub async fn cancellable<T>(
    cancelled: Arc<AtomicBool>,
    seconds: u64,
    future: impl Future<Output = Result<T, AiError>>,
) -> Result<T, AiError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(AiError::new("cancelled", "The request was cancelled."));
    }
    let cancel = async {
        loop {
            if cancelled.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    tokio::select! {
        biased;
        _ = cancel => Err(AiError::new("cancelled", "The request was cancelled.")),
        result = tokio::time::timeout(Duration::from_secs(seconds), future) => {
            result.unwrap_or_else(|_| Err(AiError::new("timeout", "The model request timed out. It was not automatically retried.")))
        }
    }
}

pub fn network_error(error: reqwest::Error) -> AiError {
    // reqwest errors can contain the endpoint; never forward their display/source
    // or a server error body (which can echo prompts, auth headers and secrets).
    if error.is_timeout() {
        AiError::new(
            "timeout",
            "The model request timed out. It was not automatically retried.",
        )
    } else if error.is_connect() {
        AiError::new(
            "connection_failed",
            "Could not connect securely to the configured model service. Check its address and certificate.",
        )
    } else {
        AiError::new(
            "connection_interrupted",
            "The model connection was interrupted. It was not automatically retried.",
        )
    }
}

pub fn check_status(response: &reqwest::Response) -> Result<(), AiError> {
    let status = response.status();
    if status.is_redirection() {
        return Err(AiError::new(
            "redirect_blocked",
            "The model service redirected the request. Update the connection address before retrying.",
        ));
    }
    if status.is_success() {
        return Ok(());
    }
    let (code, message) = match status.as_u16() {
        401 | 403 => (
            "authentication_failed",
            "The service rejected access. Check the API key, region and model permissions.",
        ),
        404 => (
            "not_found",
            "The service endpoint or model was not found. Model IDs can also be entered manually.",
        ),
        429 => (
            "rate_limited",
            "The service reported a rate or quota limit. Retry explicitly when it is available.",
        ),
        400 | 422 => (
            "request_rejected",
            "The service rejected the request or its options. Check the selected protocol and model.",
        ),
        500..=599 => (
            "service_unavailable",
            "The model service is unavailable. The request was not automatically retried.",
        ),
        _ => (
            "http_error",
            "The model service returned an unsuccessful HTTP status.",
        ),
    };
    Err(AiError::new(code, message))
}

pub async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, AiError> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(response_too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(response_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn response_too_large() -> AiError {
    AiError::new(
        "response_too_large",
        "The model response exceeded the local byte limit.",
    )
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
