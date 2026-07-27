# CoreRobin Privacy Notice

Last reviewed: 2026-07-27

CoreRobin is a local desktop application. It reads system status, running applications, and the results of a space scan you explicitly start so it can show local status, diagnosis, and cleanup review. This notice covers the application itself. The website, GitHub Releases, and GitHub Issues are also subject to the policies of the services that host them.

## What CoreRobin does not do

- CoreRobin does not include product analytics, a crash-reporting SDK, or an account-sync service.
- CoreRobin does not upload monitoring, file-scan, process, connection, history, or preference data to our servers.
- A normal space scan does not read file contents. Only an explicit duplicate-file check reads candidate contents and calculates SHA-256 locally. Neither scan uploads, moves, or changes files.
- CoreRobin never automatically stops processes, uninstalls applications, or deletes files.

## Data processed and stored on this computer

- **Live status**: local snapshots of CPU, memory, storage, network, applications, processes, startup items, and connections for the current interface and diagnosis.
- **Local history and action records**: resource history stores trends, persistent conditions, app-watch trigger/recovery events, and confirmed action results when enabled. App and startup-item names persist only after the separate name opt-in. Connection history has its own switch and is off by default; when enabled it stores application names, reverse-resolved hostnames or remote IPs, protocol, port, and five-minute observation counts locally, capped at 5,000 entries for 1, 7, or 30 days.
- **Application inventory cache**: on macOS, the app data directory stores installed apps' localized names, paths, Bundle IDs, bundle sizes, timestamps, and an application-directory fingerprint for each interface language to avoid repeat scans. A refresh is recommended after 24 hours, the cache is used for at most 7 days, manual refresh rereads it, and the inventory is never uploaded.
- **Space-scan results**: normal scans read metadata and retain results for up to seven days. The duplicate-file check runs only when explicitly started, reads candidate contents to hash them, and currently does not persist its results across restarts. Cleanup uses saved scan evidence to bind each confirmed target without following symbolic links; missing targets are skipped and inaccessible or unsupported targets are reported rather than blocking unrelated items.
- **Sign-in impact**: only a real operating-system background login launch stores a measurement. The latest five include timing, CPU/disk peaks, settle time, and application names with resource peaks.
- **Preferences**: language, motion, notifications, history retention, background launch, and Robin companion preferences are stored locally to restore your choices.

## Full Disk Access on macOS

macOS protects locations such as Mail, Messages, and other application data. With Full Disk Access, CoreRobin can read the system disk's **metadata** more completely, reducing protected-location gaps in the space map.

- macOS controls this permission, and you can turn it off in System Settings → Privacy & Security → Full Disk Access.
- Without it, you can still choose **Scan accessible areas**; protected or temporarily unreadable locations are identified in the result.
- The normal space map remains metadata-only. An explicit duplicate-file check can read accessible candidate contents to hash them. Full Disk Access never permits deletion without confirmation.

## Network requests

- Opening Network Quality runs one check immediately and repeats it every 30 seconds while the page remains open; leaving the page stops checks, and you can also retest manually. Each check separates the local route, system DNS resolution of `example.com`, IPv4/IPv6 availability, direct public reachability, and an independent `example.com:443` service probe. It opens lightweight TCP connections to estimate latency, jitter, and connection-failure ratio and sends no HTTP request content.
- When connection history is enabled, CoreRobin asks the configured system resolver to reverse-resolve up to 32 remote IPs for hostname aggregation. Failed lookups keep the IP fallback; the connection list is not sent to a CoreRobin server.
- When you open About & Support or the daily background check runs, the signed updater requests `latest.json` from the public `JimmyDaddy/corerobin-monitor` GitHub Release. Downloading an update retrieves the selected installer from that public Release.
- Your network provider, DNS provider, or target host may process these requests under its own policies. Disabling connection history stops new reverse lookups.

## Clearing data and uninstalling

- Settings → About & Support → **Clear all local data** clears CoreRobin preferences, history, notification records, application-inventory cache, file-insight cache, and saved space-scan results. You can instead clear only history in Records or only the saved scan in Cleanup.
- Cleanup only affects targets you place in the cleanup basket and confirm again. You can move them to system Trash or choose irreversible direct deletion; CoreRobin never silently falls back from one mode to the other.
- Cleanup normally handles content in your home folder. It also permits current-user-owned children of approved temporary roots such as `/tmp`, `/var/tmp`, and the current macOS user's private temporary/cache directories; the roots themselves, other users' entries, links, special objects, system-managed locations, and other disks remain protected.
- On macOS, the Complete Uninstall Assistant reads the selected app's metadata locally. With a valid Bundle ID it lists the bundle and leftovers attributable to that exact ID; without one it can still offer bundle-only uninstall. The plan is not uploaded, and you review every path.
- To stop background monitoring, choose **Quit app** from the menu bar instead of only closing the main window. You can then confirm that no CoreRobin process remains in Activity Monitor, Task Manager, or your system monitor.
- Before a full uninstall, turn off **Launch after sign-in** in Settings. On macOS, you can also turn CoreRobin off in System Settings → Privacy & Security → Full Disk Access; clearing app data does not revoke an operating-system permission for you.

### Complete uninstall and local data locations

CoreRobin's production application identifier is `com.corerobin.monitor`. Normally, use the in-app clearing action and then remove the application through the operating system. If you need to check leftovers manually, **quit CoreRobin completely first**, then inspect the locations below. An operating-system or WebView version may create only some of them.

| Platform | CoreRobin data and WebView storage | Login-launch entry |
| --- | --- | --- |
| macOS | `~/Library/Application Support/com.corerobin.monitor/` (the native scan cache is `cleanup-scan-v3.json`); possible WebView or system-preference leftovers include `~/Library/WebKit/com.corerobin.monitor/`, `~/Library/Caches/com.corerobin.monitor/`, and `~/Library/Preferences/com.corerobin.monitor.plist` | `~/Library/LaunchAgents/core-robin.plist` |
| Windows | `%APPDATA%\com.corerobin.monitor\` may contain native scan data; possible WebView2 and local-cache data includes `%LOCALAPPDATA%\com.corerobin.monitor\` | The `core-robin` value under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` and `…\Explorer\StartupApproved\Run` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.corerobin.monitor/` may contain native scan and WebView data; if `XDG_CACHE_HOME` is set, a matching cache location may also exist | `${XDG_CONFIG_HOME:-~/.config}/autostart/core-robin.desktop` |

Do not delete another application's similarly named directory outside this identifier. If you are unsure, post only the operating-system version, CoreRobin version, and a **redacted directory listing** in a public Issue; never upload the directory contents.

## Website, Issues, and security reports

The website is a static GitHub Pages site and does not embed product analytics. GitHub Releases distribute installers, checksums, SBOMs, and Sigstore bundles.

Public Issues are visible to everyone. Copy the version and diagnostic summary from Settings → About & Support, preview it, and remove usernames, file paths, IP addresses, access tokens, personal details in screenshots, and other unnecessary data before posting. Report security issues through GitHub Private Vulnerability Reporting, never a public Issue.

## Contact

- General support and feature requests: [GitHub Issue chooser](https://github.com/JimmyDaddy/corerobin-monitor/issues/new/choose)
- Security vulnerabilities: [Private Vulnerability Reporting](https://github.com/JimmyDaddy/corerobin-monitor/security/advisories/new)

If the product's data boundaries change, this notice and the corresponding release notes will be updated with that version.
