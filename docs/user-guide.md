# CoreRobin User Guide

CoreRobin brings CPU, memory, storage, network activity, and running apps into one clear desktop view. When your computer slows down, storage runs low, or network activity spikes, it helps you find the cause.

## Download and install

Download the package for your platform from [GitHub Releases](https://github.com/JimmyDaddy/corerobin-monitor/releases/latest). Current macOS DMGs are Developer ID signed, Apple-notarized, and stapled; Gatekeeper validation is repeated before publication. Apple Silicon is the primary real-hardware validation path. The Intel package receives the same signing and automated checks but has not completed separate Intel hardware acceptance. Windows and Linux packages are early previews without platform signing or separate real-device validation. Releases include SHA-256 checksums, an SPDX SBOM, and a Sigstore signature bundle for the checksum manifest; these source-integrity records do not replace platform signing or real-device validation.

## First launch

1. Give the app a few seconds to collect its first readings. Disk and network speeds may show a warm-up message until the next refresh.
2. Everyday mode first tells you how the computer is doing and offers one useful next step. You do not need to inspect a row of status cards.
3. If you already notice slowness, heat, battery drain, low space, slow startup, or a network problem, open Help me solve and choose the closest description.
4. Use the upper-right Settings menu for language, notifications, history, and background launch behavior. The interface supports Simplified Chinese, Traditional Chinese, English, Japanese, German, French, Spanish, Brazilian Portuguese, Korean, and Russian. Language and Everyday/Professional mode use consistent top-bar controls; switch to Professional mode when you need a process tree, connection details, or command lines.

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
- The Complete Uninstall Assistant currently supports top-level macOS apps. It identifies the app bundle and only leftovers attributed by an exact Bundle ID, then asks you to review every path. Moving to Trash is the default; direct deletion requires separate confirmation. CoreRobin cannot uninstall itself and excludes paths it cannot attribute safely.
- CPU, memory, and disk evidence stays under Why this conclusion.
- Professional mode adds a process tree, search, sorting, file locations, launch commands, and five-minute trends.
- Prefer Request Stop so an app has time to save its work. Use Force Stop only when an app is completely unresponsive.
- CoreRobin checks the target again before stopping it. If the process has exited or changed, the action stops.
- After an action, Everyday mode checks again and tells you whether the app actually stopped.
- Critical system processes and CoreRobin itself cannot be stopped by mistake.

### Storage

- See how much space is left on each disk, recent read and write activity, and which apps are using the disk heavily.
- When space is running low, open Cleanup directly from this page.

### Cleanup

When no result exists yet, Cleanup first shows the scan scope, read-only boundary, and a **Start read-only scan** button; live progress appears only after scanning begins. Once complete, a sunburst map shows what is taking up space. The default **File paths** view follows the real directory hierarchy; **Purpose** regroups common downloads, caches, and app data as a supporting view. The scan does not cross into external disks or other mounted filesystems.

On macOS, Mail, Messages, other app data, and similar locations are protected by the system. Before the first scan, CoreRobin explains why Full Disk Access is useful and opens System Settings → Privacy & Security → Full Disk Access. If CoreRobin is not in the list yet, click `+` below it and select `CoreRobin.app`; the in-app “Show app in Finder” action locates it for you. Return to the app after enabling it and the scan continues automatically. You can also decline and scan only currently accessible locations. macOS controls this permission, and you can turn it off at any time.

> Delete only items you recognize and know you no longer need. Leave anything you are unsure about. Re-creatable caches are a useful starting point, but not every cache is automatically safe to remove.

1. **Let the scan finish:** The page shows where it is scanning, how many items it has checked, and how much space it has found. The scan continues until it finishes unless you stop it.
2. **Explore large folders:** Larger sectors use more space. Click a folder to open it, or click the center to go back.
3. **Add items to the basket:** Hold a sector or an item in the directory list and start dragging. While scan results exist, the basket stays fixed at the bottom of the window. Adding an item does not move or delete it.
4. **Refresh and choose a cleanup mode:** CoreRobin rescans only the basket targets and shows their latest size and item count. After reviewing them, choose **Move to Trash** (recommended and recoverable until Trash is emptied) or **Delete directly** (irreversible).

Full scan results stay on this computer for up to 7 days for browsing and are marked stale after 24 hours. Cached or expired results cannot directly authorize cleanup: opening the cleanup review performs an authoritative rescan of only the basket targets and binds that confirmation to the selected cleanup mode. If size, item count, or tree contents changed, the old confirmation expires; review the updated result, refresh it until stable, and acknowledge it again. Choose Rescan when many files elsewhere have changed.

**Duplicate and long-unmodified files** is a separate explicit check. It scans only Desktop, Documents, Downloads, Movies, Music, and Pictures without following symbolic links. It filters by size before reading likely duplicate candidates and calculating SHA-256 locally. “Long-unused” is approximated as over 100 MB and unchanged for 180 days because reliable last-access data is unavailable on many systems. Results provide preview, copy, and reveal actions only; nothing is deleted automatically.

#### Before cleanup

- **Move to Trash** items can normally be restored until system Trash is emptied. **Delete directly** bypasses Trash and cannot be restored by CoreRobin.
- If CoreRobin cannot open the system Trash safely, it explains the failure and lets you retry. It enters the irreversible path only after you explicitly choose direct deletion and confirm again.
- Start with caches that can be recreated. Do not delete downloads, project files, settings, or personal data unless you know you no longer need them.
- CoreRobin removes only regular files and folders inside your home folder.
- Your home folder, Trash itself, links, special files, and other disks are protected.
- The app rechecks each complete target tree right before cleanup. A deep new file or any other mismatch stops the action and requires another refresh and confirmation.
- Cleaned items disappear from the map and basket. Items that could not be cleaned remain visible with an explanation.

### Network

- Network is not a top-level Everyday page. Choose A network problem under Help me solve to check current traffic and connections first.
- See current upload and download speeds, traffic since launch, network interfaces, and active connections.
- Opening Network automatically checks DNS, TCP connection latency, jitter, estimated loss, and connectivity. While the page remains open, a lightweight sample runs every 30 seconds to build a recent 15-minute trend with average, peak, and anomaly counts. Sampling stops when you leave the page, and **Retest now** remains available.
- Connection history is off by default. When explicitly enabled, five-minute application and hostname-or-IP aggregates stay locally for 1, 7, or 30 days, capped at 5,000 entries, and can be cleared anytime.
- Filter connections by TCP, UDP, and connection state.
- The operating system may hide which process owns a connection. A missing app name does not mean the connection is suspicious.

### Startup items

- Startup items are not a top-level Everyday page. They appear when you choose Slow startup, together with reversible actions where supported.
- See which apps start with your computer and where they come from.
- Supported third-party items can be turned off and restored later.
- System items and sources that cannot be changed safely on the current platform are view-only.
- CoreRobin does not delete startup configuration files.
- When the operating system really launches CoreRobin as a background login item, it measures CPU, disk, application peaks, and settle time for up to three minutes. Manual launches are not counted as sign-in impact.

### History

- Everyday mode uses a simple Records timeline to show when the computer became busy and when it recovered. Professional mode keeps the full technical history and filters.
- A warning and its recovery are paired into one incident with its start time, duration, likely cause, and outcome.
- Confirmed app quit or restart, permanent cleanup, and startup-item actions also record execution and verification results. Cleanup history stores only item counts and reclaimed space, never file paths.
- Keep history for 1, 7, or 30 days, turn it off, or clear it anytime.
- Notifications appear only when a problem lasts for a while, and the same warning is not repeated constantly.
- CoreRobin follows up once after the problem has stably recovered. The main window, menu bar panel, and Robin companion share the same health state.
- CPU, memory, and storage notifications can be turned off separately.
- App and startup item names persist across restarts only after you allow names to be saved. Command lines, file locations, filenames, and connection addresses are not stored.

### Settings

- Settings groups interface, background and desktop, sampling and views, history, and notifications into consistent card grids and controls. Everyday Settings keeps language, text size, motion, desktop notifications, local history, and Robin companion preferences together.
- CoreRobin can launch quietly after system sign-in without opening the main window. On macOS, you can also choose whether it appears in the Dock and app switcher.
- Pro Settings also includes sampling rates, connection refresh, alert colors, and the default process view. On first entry, the process page selects a suitable high-load process so the details panel is useful immediately.
- App watch rules use styled app, metric, threshold, and duration controls. A rule notifies once when the sustained condition is met, can notify again only after recovery, and keeps a 10-minute cooldown.
- The Pro overview shows GPU activity and relative application energy impact when supported. Relative impact is not watts or energy; macOS currently provides the richest data and unsupported platforms report the capability as unavailable.

## Menu bar panel

Closing the main window leaves CoreRobin available in the menu bar. Click the menu bar icon to toggle a compact panel that shares the main window's current health conclusion; double-click it to open the main window directly. A quiet login launch does not show the splash screen or main window.

Choose Robin companion to open a compact bottom-right window that shares the same conclusion as the main window and menu bar panel, with one next step. Press Escape, use the close button, or click another window to dismiss it. Its dragged position is remembered, and Everyday Settings controls whether it stays on top or appears at startup.

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
