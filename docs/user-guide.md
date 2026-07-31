# CoreRobin User Guide

CoreRobin brings CPU, memory, storage, network activity, and running apps into one clear desktop view. When your computer slows down, storage runs low, or network activity spikes, it helps you find the cause.

## Download and install

Download the package for your platform from [GitHub Releases](https://github.com/JimmyDaddy/corerobin-monitor/releases/latest). Current macOS DMGs are Developer ID signed, Apple-notarized, and stapled; Gatekeeper validation is repeated before publication. Apple Silicon is the primary real-hardware validation path. The Intel package receives the same signing and automated checks but has not completed separate Intel hardware acceptance. Windows and Linux packages are early previews without platform signing or separate real-device validation. Releases include SHA-256 checksums, an SPDX SBOM, and a Sigstore signature bundle for the checksum manifest; these source-integrity records do not replace platform signing or real-device validation.

## First launch

1. Give the app a few seconds to collect its first readings. Disk and network speeds may show a warm-up message until the next refresh.
2. Everyday mode first tells you how the computer is doing and offers one useful next step. You do not need to inspect a row of status cards.
3. If you already notice slowness, heat, battery drain, low space, slow startup, or a network problem, open Help me solve and choose the closest description.
4. Use Settings for language, notifications, history, privacy, and background launch behavior. The interface supports Simplified Chinese, Traditional Chinese, English, Japanese, German, French, Spanish, Brazilian Portuguese, Korean, and Russian. The Everyday/Professional switch stays at the bottom of the shared sidebar, so it remains in the same place in both modes; switch to Professional mode when you need a process tree, connection details, or command lines.

## Main pages

### Computer status

- The Robin companion gives one current conclusion and one primary action. When no sustained issue is present, it simply says there is nothing to do.
- When something needs attention, the primary action opens the highest-priority problem instead of asking you to choose between CPU, memory, storage, and network.
- The page keeps one priority item and one recent change. CoreRobin checks recent trends before raising a concern, so a brief spike is not treated as a problem. It does not invent a health score.
- A confirmed condition keeps a stable identity instead of disappearing after one normal sample. When the reading drops, it stays in a recovering state until recovery is stable.
- Data that cannot be read is marked unavailable instead of being treated as normal.

### Help me solve

- Start with what you notice: a slow computer, a loud fan, fast battery drain, low space, slow startup, or a network problem.
- The page shows only the current stage: observing, finding a cause, choosing an action, or checking again.
- Each result explains what happened, why it matters, and what you can do. CPU, memory, and disk numbers stay under Why this conclusion.
- CoreRobin asks before requesting an app to quit, changing a startup item, or deleting a file. It does not act automatically.

### Apps

- Apps is a top-level entry in both Everyday and Professional mode. Everyday mode provides a stable app-impact snapshot; Professional mode opens the Complete Uninstall Assistant directly.
- The inventory prefers the localized app name that matches the interface language and reuses the app's real icon. A local cache and application-directory fingerprint allow background refresh without a full scan on every visit; manual refresh forces a new read.
- Sort the inventory by size, last use, source, or name, and filter apps that have not been used for 90 or 180 days. The optional Trash watcher runs while CoreRobin is open, shows a badge outside the Apps page, and only offers a residual-data plan for an exact Bundle ID; it never removes anything automatically.
- On macOS, the Complete Uninstall Assistant identifies the app bundle and only leftovers attributed by an exact Bundle ID, then asks you to review every path. Moving to Trash is the default; direct deletion requires separate confirmation. On Windows it creates short-lived plans from the system MSI/MSIX catalogs, and on Linux from Flatpak, deb, RPM, or Snap ownership, then delegates removal to the operating-system installer or package manager. Identity is revalidated before execution and the frontend cannot supply a command. Portable or unverifiable apps remain view-only, and CoreRobin cannot uninstall itself.
- CPU, memory, and disk evidence stays under Why this conclusion.
- Professional mode adds a process tree, search, sorting, file locations, launch commands, and five-minute trends.
- Prefer Request Stop so an app has time to save its work. On Windows this asks the app's top-level windows to close; on Linux it sends the normal termination request through a stable process handle. Use Force Stop only when an app is completely unresponsive. Windows/Linux process control remains an early-preview capability until its dedicated real-device smoke passes.
- CoreRobin checks the target again before stopping it. If the process has exited or changed, the action stops.
- After an action, Everyday mode checks again and tells you whether the app actually stopped.
- Critical system processes and CoreRobin itself cannot be stopped by mistake.

### Storage

- See how much space is left on each disk, recent read and write activity, and which apps are using the disk heavily.
- Removable volumes show an **Eject** action. CoreRobin asks once, then requests a safe operating-system eject and refreshes the volume list without restarting the app.
- Storage details show read-only filesystem, mount-mode, internal/external, solid-state, and operating-system S.M.A.R.T. status where available. Each volume check has a watchdog, up to four volumes are inspected concurrently, successful results are cached for ten minutes, and an individual volume can be retried without blocking the others. A warning can open the system disk utility; CoreRobin neither repairs a disk nor invents a health percentage.
- When space is running low, open Cleanup directly from this page.

### Cleanup

When no result exists yet, Cleanup first shows the scan scope, read-only boundary, and a **Start read-only scan** button; live progress appears only after scanning begins. You can scan the system disk, a currently mounted external/removable volume, or one directory chosen through the system folder picker. The five most recent non-system targets stay locally for quick reuse. Every scan remains inside the selected filesystem boundary and does not cross into another mount. Once complete, a sunburst map shows what is taking up space. The default **File paths** view follows the real directory hierarchy; **Purpose** regroups common downloads, caches, and app data as a supporting view.

On macOS, Mail, Messages, other app data, and similar locations are protected by the system. Before the first scan, CoreRobin explains why Full Disk Access is useful and opens System Settings → Privacy & Security → Full Disk Access. If CoreRobin is not in the list yet, click `+` below it and select `CoreRobin.app`; the in-app “Show app in Finder” action locates it for you. Return to the app after enabling it and the scan continues automatically. You can also decline and scan only currently accessible locations. macOS controls this permission, and you can turn it off at any time.

> Delete only items you recognize and know you no longer need. Leave anything you are unsure about. Re-creatable caches are a useful starting point, but not every cache is automatically safe to remove.

1. **Let the scan finish:** The page shows where it is scanning, how many items it has checked, and how much space it has found. The scan continues until it finishes unless you stop it.
2. **Explore large folders:** Larger sectors use more space. Click a folder to open it, or click the center to go back.
3. **Add items to the basket:** Use the explicit **Add to cleanup basket** action, press Enter/Space on a focused item, or drag a sector or directory-list item. While scan results exist, the basket stays fixed at the bottom of the window. Adding an item does not move or delete it.
4. **Review and choose a cleanup mode:** Review the name, path, and scanned size, then choose **Move to Trash** (recommended and recoverable until Trash is emptied) or **Delete directly** (irreversible). Switching modes does not repeat a deep scan.

Full scan results stay on this computer for up to 7 days for browsing and are marked stale after 24 hours. Cleanup uses the selected scan evidence to open each target through a stable filesystem boundary. At execution time, existing regular files and folders are removed, missing items are treated as already gone, and inaccessible or unsupported objects are skipped and reported. The app does not force a recursive rescan every time you open the review or switch cleanup modes. Choose **Rescan** when you want an up-to-date space map.

For each scan target, CoreRobin keeps up to three compact snapshots and shows total growth plus the fastest-growing top-level directories on the next scan. After cleanup, the receipt distinguishes selected logical size, selected physical allocation, physical allocation actually processed, and the change in filesystem free space. Trash, APFS snapshots, purgeable space, and delayed reclaim can make those values differ.

**Duplicate and long-unmodified files** is a separate explicit check. It scans only Desktop, Documents, Downloads, Movies, Music, and Pictures without following symbolic links. It filters by size before reading likely duplicate candidates and calculating SHA-256 locally. “Long-unused” is approximated as over 100 MB and unchanged for 180 days because reliable last-access data is unavailable on many systems. Results are retained for up to seven days. Reopening incrementally checks known path, size, mtime, device ID, and inode values and only rehashes changed duplicate candidates instead of repeating the full scan. Both duplicate and long-unmodified files can be selected into the same cleanup basket, reusing Trash, direct delete, per-item skip results, and action history. Nothing is deleted automatically.

#### Before cleanup

- **Move to Trash** items can normally be restored until system Trash is emptied. **Delete directly** bypasses Trash and cannot be restored by CoreRobin.
- If CoreRobin cannot open the system Trash safely, it explains the failure and lets you retry. It enters the irreversible path only after you explicitly choose direct deletion and confirm again.
- Start with caches that can be recreated. Do not delete downloads, project files, settings, or personal data unless you know you no longer need them.
- CoreRobin lets you collect concrete app-owned data, including dot-prefixed app folders, `Application Support/<app>`, individual preference files, and sandbox app directories. These remain **Review required** data and are never presented as safely regeneratable caches.
- Broad category roots such as your home folder, `Library`, `Application Support`, `Containers`, and `AppData` stay view-only. Credential stores, Mail, Messages, Keychains, photo libraries, cloud-sync roots, and operating-system locations remain hard protected.
- When you explicitly scan one folder or an external volume, CoreRobin can also process current-user-owned children inside that boundary. It still protects the scan root and will not follow links, handle special objects, cross into another filesystem, or delete another user’s data.
- Current-user-owned children of approved temporary locations such as `/tmp`, `/var/tmp`, and the current macOS user’s private `T`/`C` directories are also allowed; the temporary roots themselves remain protected.
- The app binds every target without following symbolic links. If one item is missing or inaccessible, it skips or reports that item and continues with the remaining confirmed targets.
- Cleaned items disappear from the map and basket. Items that could not be cleaned remain visible with an explanation.

### Network

- Network is not a top-level Everyday page. Choose A network problem under Help me solve to check current traffic and connections first.
- See current upload and download speeds, traffic since launch, network interfaces, and active connections.
- Opening Network automatically separates local routing, DNS, IPv4, IPv6, and direct internet reachability, then alternates probes across two independent targets. While the page remains open, a lightweight sample runs every 30 seconds to build a recent 15-minute latency, jitter, and TCP-probe-failure trend with average, peak, and anomaly counts. Sampling stops by default when you leave, and **Check now** remains available. If you explicitly enable long-term network-quality history, the closed page uses five-minute sampling and aggregate buckets for one-hour, 24-hour, or seven-day views; the seven-day graph is downsampled into 30-minute buckets. The timeline explains sleep/wake gaps, active-interface or default-route changes, status changes, DNS failures, and direct-connectivity failures, and summarizes recent brief outages. Only a one-way route fingerprint is retained, never the gateway address.
- Connection history is off by default. When explicitly enabled, five-minute application and hostname-or-IP aggregates stay locally for 1, 7, or 30 days, capped at 5,000 entries, and can be cleared anytime. Select an application or domain aggregate to inspect the reverse application/domain relationship, ports and protocols, and first/last observation times.
- Filter connections by TCP, UDP, and connection state.
- The operating system may hide which process owns a connection. A missing app name does not mean the connection is suspicious.

### Startup items

- Startup items are not a top-level Everyday page. They appear when you choose Slow startup, together with reversible actions where supported.
- See which apps start with your computer and where they come from. On macOS, modern background items and legacy launch files are grouped by responsible application and can show Bundle ID, Team ID, signature state, executable path, last reported state, and missing executables. System-managed or unverifiable items remain read-only.
- Supported third-party items can be turned off and restored later.
- System items and sources that cannot be changed safely on the current platform are view-only.
- CoreRobin does not delete startup configuration files.
- When the operating system really launches CoreRobin as a background login item, it measures CPU, disk, application peaks, and settle time for up to three minutes. Manual launches are not counted as sign-in impact.
- The latest measurement is compared with the median of up to four earlier launches, including settle-time change and the app whose impact rose most. After you disable or restore a startup item, the next real login measurement automatically reports whether startup improved.

### History

- Everyday mode starts Review with a today summary of attention items, recoveries, confirmed actions, and network changes, followed by a simple timeline showing when the computer became busy and recovered. Process quit/restart effects are described only when enough before-and-after samples exist; other actions show their own verification result without claiming causation. Professional mode keeps the full technical history and filters.
- A warning and its recovery are paired into one incident with its start time, duration, likely cause, and outcome.
- A selectable system-event replay correlates resource peaks, network and sleep events, app attribution, and confirmed actions in the same time range. Completed actions show verified, partial, failed, interrupted, and retry states; when enough samples exist, CoreRobin compares the following 15 minutes with the preceding period without claiming causality.
- Confirmed app quit or restart, cleanup, uninstall, volume eject, startup-item changes, and application updates record execution and verification results. Cleanup history stores only item counts and reclaimed space, never file paths.
- Keep history for 1, 7, or 30 days, turn it off, or clear it anytime.
- Notifications appear only when a problem lasts for a while, and the same warning is not repeated constantly.
- CoreRobin follows up once after the problem has stably recovered. The main window, menu bar panel, and Robin companion share the same health state.
- CPU, memory, and storage notifications can be turned off separately.
- App and startup item names persist across restarts only after you allow names to be saved. Command lines, file locations, filenames, and connection addresses are not stored.
- Optional application-impact history uses five-minute aggregates for one-hour, 24-hour, and seven-day attribution of CPU, memory, and disk usage. Select a timeline interval to see the ranking from that period; an incident's peak can open the same historical ranking directly. The panel also reports its last successful save, private-storage size, and any persistence failure. It stores only a stable app identity, aggregate values, and app names when name storage is allowed; it never stores PIDs, command lines, or file paths.
- Resource, alert, network-quality, connection, action, watch-rule, startup-impact, and compact cleanup-scan histories use separate atomic files in CoreRobin's native private data directory. The status bar and History page expose the latest successful sample/save, storage size, consecutive sampler failures, and a degraded reason instead of silently dropping data.
- Battery sessions begin when power switches to battery and summarize charge drain, likely resource-leading apps, and sleep blockers from saved aggregates. App and blocker names are retained only when history name storage is enabled.
- Once enough resource history exists, the local baseline compares the latest 15 minutes with robust same-hour samples from the past seven days while retaining absolute safety thresholds. A metric needs coverage across at least three distinct comparable days before CoreRobin describes it as established; otherwise the interface says that part of the baseline is still learning and shows its coverage. It does not produce a combined health score.
- App watch-rule trigger and recovery events appear in the local timeline, so a notification remains explainable after it disappears from the desktop.

### Settings

- Settings groups interface, background and desktop, sampling and views, notifications, and **Data & privacy** into consistent card grids and controls. The privacy center shows item count, size, update time, and retention for resource and application-impact history, connection/network-quality history, application inventory, and scan caches. Categories can be cleared separately with success/failure receipts; clear-all uses the same confirmation and retryable partial-failure flow.
- CoreRobin can launch quietly after system sign-in without opening the main window. On macOS, you can also choose whether it appears in the Dock and app switcher.
- Pro Settings also includes sampling rates, connection refresh, alert colors, and the default process view. On first entry, the process page selects a suitable high-load process so the details panel is useful immediately.
- App watch rules use styled app, metric, threshold, and duration controls. A rule notifies once when the sustained condition is met, can notify again only after recovery, and keeps a 10-minute cooldown.
- Preferences and application watch rules can be previewed, exported, and imported through a local JSON file. The backup excludes history, paths, connections, and scan results.
- The updater is an app-level task: it checks periodically and retries after the network returns. A new release appears as a non-blocking card at the top of the main window with **Update now**, **Remind me tomorrow**, and **Skip this version**; skipping one version does not hide a later release. Download, signature verification, and installation continue in CoreRobin's native background task when the main window is hidden, and reopening or reloading the window reconnects to the same progress instead of starting over. A failed transfer remains available to retry. Installation is followed by an in-app restart action and a post-restart receipt. The report flow first previews a redacted diagnostic summary, then lets you copy it and open a GitHub Issue prefilled with version, system, and architecture. CoreRobin uploads no logs; you write the problem and reproduction steps.
- The Pro overview shows GPU activity and relative application energy impact when supported. Relative impact is not watts or energy; macOS currently provides the richest data and unsupported platforms report the capability as unavailable.

## Menu bar panel

Closing the main window leaves CoreRobin available in the menu bar. Click the menu bar icon to toggle a compact panel that shares the main window's current health conclusion; double-click it to open the main window directly. A quiet login launch does not show the splash screen or main window.

Choose Robin companion to open a compact bottom-right window that shares the same conclusion as the main window and menu bar panel, with one next step. Double-click Robin or use its right-click menu to open the main window. Its dragged position is remembered, and Everyday Settings controls whether it stays on top or appears at startup.

To stop monitoring completely, quit CoreRobin instead of only closing the window.

## Platform support and known limitations

| Platform | Current status | Validation coverage |
| --- | --- | --- |
| macOS · Apple Silicon | Recommended | M-series Macs are the primary hardware-tested path; use the `aarch64.dmg` |
| macOS · Intel | Available, awaiting hardware acceptance | A signed, notarized, and stapled `x64.dmg` passes automated build, architecture, signature, and Gatekeeper checks, but has not completed Intel hardware acceptance |
| Windows · x64 | Early preview | Automated builds and tests pass; real-device, desktop-integration, and installer coverage remain limited |
| Linux · x64 | Early preview | Automated builds and tests pass; distro, desktop-environment, and WebKitGTK combinations are not comprehensively tested |

Current macOS installers have Developer ID signing and Apple notarization. Windows installers do not have platform signing, and Windows and Linux remain early previews. Temperature, battery health, connection ownership, and some startup-item features depend on the operating system and hardware; unavailable readings are labeled as such. The website recommends only an operating system from browser signals, cannot reliably identify a Mac chip, and never downloads automatically. See the public [Release Notes](https://monitor-app.corerobin.com/en/releases/) for version changes and current limitations.

## Common questions

### Why are disk and network speeds missing right after launch?

The app needs two readings to calculate a rate. The numbers appear after the next refresh.

### Why is the scan taking a long time?

Scan time depends mostly on the number of files and disk speed, not total disk size. Many small files usually take longer than a few large files. Progress keeps updating, and you can stop the scan.

### Why does the size differ from Finder or Explorer?

CoreRobin shows the space files actually occupy on disk. Compression, sparse files, and hard links can make this number differ from the listed file size.

### Why are some connections missing app names?

The operating system may hide which process owns a connection. CoreRobin does not elevate itself automatically to fill in that information.

### Which package should I download?

Use the download page to match your system and chip: `aarch64.dmg` is for every Apple Silicon Mac, including M-series chips such as M3; `x64.dmg` is only for Intel Macs. The website can detect macOS but cannot reliably identify the Mac chip, so check Apple menu → About This Mac when unsure. Windows users can choose `x64-setup.exe` or `x64_en-US.msi`, and x64 Linux users can choose AppImage or deb. Windows and Linux are early previews. The download page states package size, platform status, and verification steps.

### macOS says CoreRobin cannot be verified, or it is missing from Full Disk Access. What should I do?

Current macOS installers are Apple-notarized and stapled, so the latest release should not normally require Open Anyway. If it is still blocked, confirm it came from the official Release, install it in Applications, and verify its SHA-256; report the macOS, chip, and CoreRobin versions if the problem remains. If CoreRobin is missing from Full Disk Access, launch it once from Applications, then use `+` below the list to choose it. The app can also reveal its location in Finder.

### macOS says CoreRobin is damaged. Should I use Open Anyway?

No. “Damaged” indicates a package, signature, or download-integrity problem; do not bypass it with Open Anyway or by removing quarantine attributes. The v0.0.3 Apple Silicon DMG had an incomplete signature and was replaced by later releases. Current macOS packages also pass Developer ID signing, Apple notarization, stapling, and Gatekeeper validation. Delete the old DMG and app copy, download the latest package, and verify it against `SHA256SUMS`. If the message remains, report the macOS version, Mac chip, CoreRobin version, and checksum result.

### Can I scan without Full Disk Access?

Yes. Choose **Scan accessible areas** to continue with locations available to the current account and system. Protected or temporarily unreadable locations are identified in the result. The permission only makes the system-disk map more complete; scans still read metadata, not file contents.

### Is CoreRobin still running after I close the main window? How do I close Robin?

Yes. Closing the main window hides it while monitoring continues in the menu bar. Quit CoreRobin from the menu bar to stop monitoring. Dismiss the Robin companion with its close button, Escape, or its setting; dismissing Robin does not quit the app.

### How do I clear data or uninstall completely?

1. Turn off **Launch after sign-in** in Settings. If you plan to keep the app and only want a reset, choose **Clear all local data** in Settings → About & Support.
2. You can also clear history in Records and remove the saved scan from Cleanup separately.
3. On macOS, turn CoreRobin off in System Settings → Privacy & Security → Full Disk Access.
4. Choose **Quit app** in the menu bar panel, then confirm that no CoreRobin process remains in Activity Monitor, Task Manager, or your system monitor.
5. Remove the CoreRobin application. The Complete Uninstall Assistant cannot uninstall CoreRobin while it is running; to check for leftovers manually, use the [per-platform locations in the Privacy Notice](privacy.md#complete-uninstall-and-local-data-locations).

Do not attach logs, local data folders, unredacted screenshots, or generated diagnostics directly to a public Issue. Copy the version and diagnostic summary from Settings → About & Support, preview it, and remove usernames, paths, IP addresses, and other private details first.

## Privacy and support

Monitoring, file, process, history, and connection data stay on this computer. They are not uploaded or synced. Normal space scans read metadata such as names, sizes, and locations. Only the duplicate-file check you explicitly start reads candidate contents to hash them locally. See the [Privacy Notice](privacy.md) for retention, Full Disk Access, and data-clearing details.

For general problems, open a GitHub issue and copy the version and system details from Settings → About & Support. Include what you were doing and any visible error. Read the [Release Notes](https://monitor-app.corerobin.com/en/releases/) for version changes, and use GitHub private vulnerability reporting for security issues.
