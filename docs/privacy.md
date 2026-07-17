# CoreRobin Privacy Notice

Last reviewed: CoreRobin 0.0.4 (2026-07-17)

CoreRobin is a local desktop application. It reads system status, running applications, and the results of a space scan you explicitly start so it can show local status, diagnosis, and cleanup review. This notice covers the application itself. The website, GitHub Releases, and GitHub Issues are also subject to the policies of the services that host them.

## What CoreRobin does not do

- CoreRobin 0.0.4 does not include product analytics, a crash-reporting SDK, or an account-sync service.
- CoreRobin does not upload monitoring, file-scan, process, connection, history, or preference data to our servers.
- A space scan does not read file contents and never moves, changes, or uploads files while scanning.
- CoreRobin never automatically stops processes, uninstalls applications, or deletes files.

## Data processed and stored on this computer

- **Live status**: local snapshots of CPU, memory, storage, network, applications, processes, startup items, and connections for the current interface and diagnosis.
- **Local history and action records**: when history is enabled, resource trends, persistent conditions, and results of actions you confirm are stored on the device. History can be kept for 1, 7, or 30 days, disabled, or cleared at any time. App and startup-item names persist across restarts only when you opt in; command lines, file paths, file names, and connection addresses are not saved.
- **Space-scan results**: scans read metadata such as names, sizes, dates, locations, and file types, not file contents. Results are retained for up to 7 days and marked stale after 24 hours. Before permanent deletion, CoreRobin rechecks only the targets you put in the cleanup basket.
- **Preferences**: language, motion, notifications, history retention, background launch, and Robin companion preferences are stored locally to restore your choices.

## Full Disk Access on macOS

macOS protects locations such as Mail, Messages, and other application data. With Full Disk Access, CoreRobin can read the system disk's **metadata** more completely, reducing protected-location gaps in the space map.

- macOS controls this permission, and you can turn it off in System Settings → Privacy & Security → Full Disk Access.
- Without it, you can still choose **Scan accessible areas**; protected or temporarily unreadable locations are identified in the result.
- This permission does not allow a scan to read file contents or to delete anything without confirmation.

## Clearing data and uninstalling

- Use Records to clear saved history and Cleanup to clear a saved scan result.
- Permanent deletion only affects targets you place in the cleanup basket and confirm again; files do not go to Trash.
- To stop background monitoring, quit CoreRobin from the menu bar rather than only closing the main window.
- Before a full uninstall, clear history and scan results if desired, then remove CoreRobin using your operating system's application-uninstall flow.

## Website, Issues, and security reports

The website is a static GitHub Pages site and does not embed product analytics. GitHub Releases distribute installers, checksums, SBOMs, and Sigstore bundles.

Public Issues are visible to everyone. Remove usernames, file paths, IP addresses, access tokens, personal details in screenshots, and other unnecessary data before posting. Report security issues through GitHub Private Vulnerability Reporting, never a public Issue.

## Contact

- General support and feature requests: [GitHub Issue chooser](https://github.com/JimmyDaddy/corerobin-monitor/issues/new/choose)
- Security vulnerabilities: [Private Vulnerability Reporting](https://github.com/JimmyDaddy/corerobin-monitor/security/advisories/new)

If the product's data boundaries change, this notice and the corresponding release notes will be updated with that version.
