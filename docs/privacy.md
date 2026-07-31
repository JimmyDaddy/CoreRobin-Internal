# CoreRobin Privacy Notice

Last reviewed: 2026-07-29

CoreRobin is a local desktop application. It reads system status, running applications, and the results of a space scan you explicitly start so it can show local status, diagnosis, and cleanup review. This notice covers the application itself. The website, GitHub Releases, and GitHub Issues are also subject to the policies of the services that host them.

## What CoreRobin does not do

- CoreRobin does not include product analytics, a crash-reporting SDK, or an account-sync service.
- CoreRobin does not upload monitoring, file-scan, process, connection, history, or preference data to our servers.
- A normal space scan does not read file contents. Only an explicit duplicate-file check reads candidate contents and calculates SHA-256 locally. Neither scan uploads, moves, or changes files.
- CoreRobin never automatically stops processes, uninstalls applications, or deletes files.

## Data processed and stored on this computer

- **Live status**: local snapshots of CPU, memory, storage, network, applications, processes, startup items, and connections for the current interface and diagnosis. The native sampler continues at its configured interval when the main window is closed, so menu-bar status, alerts, and histories remain current; choosing **Quit app** stops it.
- **Local history and action records**: resource trends, alerts, network quality, connections, application impact, app-watch events, startup measurements, cleanup-scan summaries, and confirmed action results are stored as bounded atomic segments in CoreRobin's private application-data directory when their corresponding features are enabled. The interface reports last successful save time, current bytes, and write failures, and verifies category clearing before claiming success. App and startup-item names persist only after the separate name opt-in. Application-impact history additionally requires its own opt-in and retains at most seven days of five-minute stable app identities and CPU, memory, and disk aggregates, never PIDs, command lines, or paths. Connection history is off by default; when enabled it stores application names, reverse-resolved hostnames or remote IPs, protocol, port, and five-minute observation counts locally, capped at 5,000 entries for 1, 7, or 30 days.
- **Application inventory cache**: on macOS, the app data directory stores installed apps' localized names, paths, Bundle IDs, bundle sizes, timestamps, and an application-directory fingerprint for each interface language to avoid repeat scans. A refresh is recommended after 24 hours, the cache is used for at most 7 days, manual refresh rereads it, and the inventory is never uploaded.
- **Space-scan results**: normal scans read metadata and retain results for up to seven days. Up to three compact growth snapshots per scan target retain the target identity, aggregate size, and top-level path and size summaries; they do not copy file contents. The duplicate-file check runs only when explicitly started and reads candidate contents to hash them. Its result is also retained for up to seven days with paths, sizes, modification time, device ID, inode, and local hashes; file contents are not stored. Reopening incrementally rechecks known metadata, rehashes changed duplicate candidates, and drops missing or identity-changed entries instead of repeating a full scan. Cleanup uses saved scan evidence to bind each confirmed target without following symbolic links; missing targets are skipped and inaccessible or unsupported targets are reported rather than blocking unrelated items.
- **Sign-in impact**: only a real operating-system background login launch stores a measurement. The latest five include timing, CPU/disk peaks, settle time, and application names with resource peaks.
- **Battery sessions**: CoreRobin derives local charge/discharge sessions from battery snapshots, including time, power source, charge range, and aggregate rate. Application names are retained only when the name-history permission is enabled; command lines and file paths are not stored.
- **Preferences**: language, motion, notifications, history retention, background launch, and Robin companion preferences are stored locally to restore your choices. Cleanup also keeps up to five absolute paths for external volumes or folders that you explicitly selected, so they can be scanned again; clearing local data removes them. A settings export is created only when you request it and contains preferences and watch rules, not histories, scan results, connection data, or diagnostic logs.
- **Optional Trash application watcher**: when enabled, CoreRobin checks top-level `.app` bundles in the current user's Trash about every 30 seconds while CoreRobin is running. It reads bundle name, path, Bundle ID, and modification time only to offer a reviewed leftover-cleanup plan. It neither inspects unrelated Trash contents nor deletes anything automatically.

## Full Disk Access on macOS

macOS protects locations such as Mail, Messages, and other application data. With Full Disk Access, CoreRobin can read the system disk's **metadata** more completely, reducing protected-location gaps in the space map.

- macOS controls this permission, and you can turn it off in System Settings → Privacy & Security → Full Disk Access.
- Without it, you can still choose **Scan accessible areas**; protected or temporarily unreadable locations are identified in the result.
- The normal space map remains metadata-only. An explicit duplicate-file check can read accessible candidate contents to hash them. Full Disk Access never permits deletion without confirmation.

## Network requests

- Opening Network Quality runs one check immediately and repeats it every 30 seconds while the page remains open; leaving the page stops checks, and you can also retest manually. Each check separates the local route, system DNS, IPv4/IPv6 availability, and direct public reachability, then alternates lightweight TCP connections to `example.com:443` and `one.one.one.one:443` to estimate latency, jitter, and the TCP probe failure ratio. It sends no HTTP request content.
- Long-term network-quality history is off by default. When enabled, a lightweight check runs every five minutes while the page is closed and stores five-minute aggregate buckets locally. You can select a one-hour, 24-hour, or seven-day window and clear it separately. Stored fields are limited to time, status, aggregate DNS/latency/jitter values, successful/total TCP probe counts, event kinds, and a one-way fingerprint of the active-interface/default-route combination; gateway addresses are not retained.
- When connection history is enabled, CoreRobin asks the configured system resolver to reverse-resolve up to 32 remote IPs for hostname aggregation. Failed lookups keep the IP fallback; the connection list is not sent to a CoreRobin server.
- The application-level signed updater checks at most daily while CoreRobin runs and retries after the network returns. It requests `latest.json` from the public `JimmyDaddy/corerobin-monitor` GitHub Release; downloading an update retrieves the selected installer from that public Release. Once you approve an update, download, local signature verification, and installation run as a native task that can continue while the main window is hidden; no update payload is sent anywhere else.
- Your network provider, DNS provider, or target host may process these requests under its own policies. Disabling connection history stops new reverse lookups.

## Clearing data and uninstalling

- Settings → **Data & privacy** shows item count, size, update time, and retention for resource/application-impact history, connection/network-quality history, application inventory, and scan caches. Each category can be cleared independently with a result receipt. About & Support → **Clear all local data** uses the same confirmation and per-category results, then clears preferences only after every category succeeds. Partial failure lists the failed categories and supports retry instead of claiming success. You can instead clear only history in Records or only the saved scan in Cleanup.
- Cleanup only affects targets you place in the cleanup basket and confirm again. You can move them to system Trash or choose irreversible direct deletion; CoreRobin never silently falls back from one mode to the other.
- Cleanup can handle concrete current-user-owned content in the home folder or inside a folder/volume boundary the user explicitly selected. Dot-prefixed app data, specific application-support files, preferences, and sandbox data remain **Review required**; credentials, keys, Mail, Messages, Keychains, photo libraries, cloud-sync roots, and operating-system locations remain hard protected. Scan roots, temporary roots, other users' entries, links, special objects, and cross-filesystem targets are never deleted.
- On macOS, the Complete Uninstall Assistant reads the selected app's metadata locally. With a valid Bundle ID it lists the bundle and leftovers attributable to that exact ID; without one it can still offer bundle-only uninstall. The plan is not uploaded, and you review every path.
- On Windows and Linux, the assistant reads only operating-system install catalogs or package databases. The frontend submits a short-lived plan ID; the backend revalidates source and package identity before invoking MSI/MSIX, Flatpak, apt/dpkg, DNF/RPM, or Snap with fixed arguments. It neither uploads the inventory nor accepts arbitrary commands or guesses related data directories.
- **Report a problem** generates a previewable redacted summary locally and opens the GitHub Issue page. CoreRobin neither submits an Issue nor uploads logs automatically; GitHub processes only the content you choose to submit in the browser.
- To stop background monitoring, choose **Quit app** from the menu bar instead of only closing the main window. You can then confirm that no CoreRobin process remains in Activity Monitor, Task Manager, or your system monitor.
- Before a full uninstall, turn off **Launch after sign-in** in Settings. On macOS, you can also turn CoreRobin off in System Settings → Privacy & Security → Full Disk Access; clearing app data does not revoke an operating-system permission for you.

### Complete uninstall and local data locations

CoreRobin's production application identifier is `com.corerobin.monitor`. Normally, use the in-app clearing action and then remove the application through the operating system. If you need to check leftovers manually, **quit CoreRobin completely first**, then inspect the locations below. An operating-system or WebView version may create only some of them.

| Platform | CoreRobin data and WebView storage | Login-launch entry |
| --- | --- | --- |
| macOS | `~/Library/Application Support/com.corerobin.monitor/` (including bounded native history segments and the `cleanup-scan-v3.json` scan cache); possible WebView or system-preference leftovers include `~/Library/WebKit/com.corerobin.monitor/`, `~/Library/Caches/com.corerobin.monitor/`, and `~/Library/Preferences/com.corerobin.monitor.plist` | `~/Library/LaunchAgents/core-robin.plist` |
| Windows | `%APPDATA%\com.corerobin.monitor\` may contain native history segments and scan data; possible WebView2 and local-cache data includes `%LOCALAPPDATA%\com.corerobin.monitor\` | The `core-robin` value under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` and `…\Explorer\StartupApproved\Run` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.corerobin.monitor/` may contain native history segments, scan data, and WebView data; if `XDG_CACHE_HOME` is set, a matching cache location may also exist | `${XDG_CONFIG_HOME:-~/.config}/autostart/core-robin.desktop` |

Do not delete another application's similarly named directory outside this identifier. If you are unsure, post only the operating-system version, CoreRobin version, and a **redacted directory listing** in a public Issue; never upload the directory contents.

## Website, Issues, and security reports

The website is a static GitHub Pages site and does not embed product analytics. GitHub Releases distribute installers, checksums, SBOMs, and Sigstore bundles.

Public Issues are visible to everyone. Copy the version and diagnostic summary from Settings → About & Support, preview it, and remove usernames, file paths, IP addresses, access tokens, personal details in screenshots, and other unnecessary data before posting. Report security issues through GitHub Private Vulnerability Reporting, never a public Issue.

## Contact

- General support and feature requests: [GitHub Issue chooser](https://github.com/JimmyDaddy/corerobin-monitor/issues/new/choose)
- Security vulnerabilities: [Private Vulnerability Reporting](https://github.com/JimmyDaddy/corerobin-monitor/security/advisories/new)

If the product's data boundaries change, this notice and the corresponding release notes will be updated with that version.
