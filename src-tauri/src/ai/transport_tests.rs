use super::*;

#[test]
fn endpoint_validation_is_offline_and_preserves_api_prefix() {
    let base = validate_endpoint(
        "https://models.example.test/team/api/v2/",
        &NetworkPolicy::Public,
    )
    .unwrap();
    assert_eq!(
        endpoint_path(&base, "messages").unwrap().as_str(),
        "https://models.example.test/team/api/v2/messages"
    );
    assert!(validate_endpoint("http://127.0.0.1:11434", &NetworkPolicy::Loopback).is_ok());
    assert!(validate_endpoint("http://localhost:11434", &NetworkPolicy::Loopback).is_ok());
    assert!(validate_endpoint("https://192.168.5.2/api", &NetworkPolicy::Private).is_ok());
    for raw in [
        "https://user:secret@example.test",
        "https://example.test?api_key=secret",
        "https://example.test#token",
        "file:///tmp/socket",
        "http://192.168.1.2",
        "http://example.test",
        "https://example.test:0",
        "https://example.test\\private",
    ] {
        assert!(
            validate_endpoint(raw, &NetworkPolicy::Public).is_err(),
            "{raw}"
        );
    }
}

#[test]
fn address_classification_blocks_metadata_and_mapped_bypasses() {
    for raw in [
        "0.0.0.0",
        "0.1.2.3",
        "224.0.0.1",
        "255.255.255.255",
        "169.254.169.254",
        "100.100.100.200",
        "168.63.129.16",
        "::",
        "ff02::1",
        "fe80::1",
        "::ffff:169.254.169.254",
        "::ffff:0.0.0.0",
        "64:ff9b::a9fe:a9fe",
        "2002:a9fe:a9fe::",
        "64:ff9b:1::a9fe:a9fe",
        "::ffff:0:169.254.169.254",
    ] {
        let ip = raw.parse().unwrap();
        for policy in [
            NetworkPolicy::Public,
            NetworkPolicy::Private,
            NetworkPolicy::Loopback,
        ] {
            assert!(validate_ip(ip, &policy).is_err(), "{raw} {policy:?}");
        }
    }
    assert!(validate_ip("::ffff:127.0.0.1".parse().unwrap(), &NetworkPolicy::Public).is_err());
    assert!(
        validate_ip(
            "::ffff:127.0.0.1".parse().unwrap(),
            &NetworkPolicy::Loopback
        )
        .is_ok()
    );
    assert!(
        validate_ip(
            "::ffff:192.168.2.1".parse().unwrap(),
            &NetworkPolicy::Private
        )
        .is_ok()
    );
    assert!(validate_ip("10.0.0.4".parse().unwrap(), &NetworkPolicy::Public).is_err());
    assert!(validate_ip("1.1.1.1".parse().unwrap(), &NetworkPolicy::Private).is_err());
    assert!(validate_ip("1.1.1.1".parse().unwrap(), &NetworkPolicy::Public).is_ok());
}

#[tokio::test]
async fn explicit_localhost_with_public_policy_never_connects() {
    assert!(validate_endpoint("https://localhost/api", &NetworkPolicy::Public).is_err());
    let url = Url::parse("https://localhost/").unwrap();
    assert!(resolve(&url, &NetworkPolicy::Public).await.is_err());
}

#[test]
fn proxy_is_explicit_and_never_embeds_authentication() {
    assert!(validate_proxy("http://127.0.0.1:8080", None).is_ok());
    assert!(validate_proxy("https://proxy.example.test:8443", None).is_ok());
    for raw in [
        "http://user:password@127.0.0.1:8080",
        "http://169.254.169.254",
        "https://proxy.example.test/path",
        "socks5://127.0.0.1:1080",
    ] {
        assert!(validate_proxy(raw, None).is_err());
    }
}

#[test]
fn proxy_network_policy_accepts_enterprise_hostnames_without_relaxing_address_checks() {
    let (url, policy) = validate_proxy(
        "https://proxy.corporate.test:8443",
        Some(&NetworkPolicy::Private),
    )
    .unwrap();
    assert_eq!(url.host_str(), Some("proxy.corporate.test"));
    assert_eq!(policy, NetworkPolicy::Private);
    assert!(validate_ip("10.20.30.40".parse().unwrap(), &policy).is_ok());
    for ip in ["169.254.169.254", "100.100.100.200", "127.0.0.1", "1.1.1.1"] {
        assert!(validate_ip(ip.parse().unwrap(), &policy).is_err(), "{ip}");
    }
    let (_, default_policy) = validate_proxy("https://proxy.corporate.test:8443", None).unwrap();
    assert_eq!(default_policy, NetworkPolicy::Public);
    assert!(validate_ip("10.20.30.40".parse().unwrap(), &default_policy).is_err());
    for (raw, policy) in [
        ("https://proxy.corporate.test", NetworkPolicy::Loopback),
        ("https://localhost", NetworkPolicy::Private),
        ("https://10.20.30.40", NetworkPolicy::Public),
        ("https://169.254.169.254", NetworkPolicy::Private),
    ] {
        assert!(
            validate_proxy(raw, Some(&policy)).is_err(),
            "{raw} {policy:?}"
        );
    }
}

#[tokio::test]
async fn cancellation_preempts_a_silent_network_future() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let trigger = cancelled.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        trigger.store(true, Ordering::Release);
    });
    let start = std::time::Instant::now();
    let result: Result<(), AiError> = cancellable(cancelled, 10, std::future::pending()).await;
    assert_eq!(result.unwrap_err().code, "cancelled");
    assert!(start.elapsed() < Duration::from_secs(1));
}
