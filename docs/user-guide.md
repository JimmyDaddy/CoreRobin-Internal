# CoreRobin User Guide

CoreRobin brings CPU, memory, storage, network activity, and running apps into one clear desktop view. When your computer slows down, storage runs low, or network activity spikes, it helps you find the cause.

## Download and install

Download the package for your platform from [GitHub Releases](https://github.com/JimmyDaddy/corerobin-monitor/releases/latest). macOS app bundles are ad-hoc signed for integrity but do not yet have Developer ID signing or Apple notarization; if macOS says the developer cannot be verified, open System Settings → Privacy & Security and confirm that you want to open CoreRobin. A message saying the app is damaged is different: do not bypass it by removing quarantine attributes; download the latest package again, verify its SHA-256 checksum, and report the release version if the message remains. Windows and Linux packages are currently early previews and do not have platform signing. Releases include SHA-256 checksums, an SPDX SBOM, and a Sigstore signature bundle for the checksum manifest; these source-integrity records do not replace platform signing.

## First launch

1. Give the app a few seconds to collect its first readings. Disk and network speeds may show a warm-up message until the next refresh.
2. Everyday mode first tells you how the computer is doing and offers one useful next step. You do not need to inspect a row of status cards.
3. If you already notice slowness, heat, battery drain, low space, slow startup, or a network problem, open Help me solve and choose the closest description.
4. Use the upper-right Settings menu for language, notifications, history, and background launch behavior. The interface supports Simplified Chinese, Traditional Chinese, English, Japanese, German, French, Spanish, Brazilian Portuguese, Korean, and Russian. When you need a process tree, connection details, or command lines, use the clearly labeled Professional mode button in the top bar.

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

- Apps are no longer a top-level Everyday page. They appear as a stable snapshot only when a check points to an app.
- The snapshot groups related processes, explains impact first, and does not reorder every second. You can refresh it or reveal the full list when needed.
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

Cleanup scans the system disk, then uses a sunburst map to show what is taking up space. The default **File paths** view follows the real directory hierarchy; **Purpose** regroups common downloads, caches, and app data as a supporting view. The scan does not cross into external disks or other mounted filesystems.

On macOS, Mail, Messages, other app data, and similar locations are protected by the system. Before the first scan, CoreRobin explains why Full Disk Access is useful and opens System Settings → Privacy & Security → Full Disk Access. If CoreRobin is not in the list yet, click `+` below it and select `CoreRobin.app`; the in-app “Show app in Finder” action locates it for you. Return to the app after enabling it and the scan continues automatically. You can also decline and scan only currently accessible locations. macOS controls this permission, and you can turn it off at any time.

> Delete only items you recognize and know you no longer need. Leave anything you are unsure about. Re-creatable caches are a useful starting point, but not every cache is automatically safe to remove.

1. **Let the scan finish:** The page shows where it is scanning, how many items it has checked, and how much space it has found. The scan continues until it finishes unless you stop it.
2. **Explore large folders:** Larger sectors use more space. Click a folder to open it, or click the center to go back.
3. **Add items to the basket:** Hold a sector and start dragging; the basket stays visible at the bottom of the window. Adding an item to the basket does not delete or move it.
4. **Refresh, then delete:** CoreRobin rescans only the basket targets and shows their latest size and item count. Continue only after reviewing those results.

Full scan results stay on this computer for up to 7 days for browsing and are marked stale after 24 hours. Cached or expired results cannot directly authorize permanent deletion: opening the deletion review performs an authoritative rescan of only the basket targets. If size, item count, or tree contents changed, the old confirmation expires; review the updated result, refresh it until stable, and acknowledge it again. Choose Rescan when many files elsewhere have changed.

#### Before permanent deletion

- Files bypass system Trash and cannot be restored by CoreRobin.
- Start with caches that can be recreated. Do not delete downloads, project files, settings, or personal data unless you know you no longer need them.
- CoreRobin removes only regular files and folders inside your home folder.
- Your home folder, Trash itself, links, special files, and other disks are protected.
- The app rechecks each complete target tree right before deletion. A deep new file or any other mismatch stops the action and requires another refresh and confirmation.
- Deleted items disappear from the map and basket. Items that could not be deleted remain visible with an explanation.

### Network

- Network is not a top-level Everyday page. Choose A network problem under Help me solve to check current traffic and connections first.
- See current upload and download speeds, traffic since launch, network interfaces, and active connections.
- Filter connections by TCP, UDP, and connection state.
- The operating system may hide which process owns a connection. A missing app name does not mean the connection is suspicious.

### Startup items

- Startup items are not a top-level Everyday page. They appear when you choose Slow startup, together with reversible actions where supported.
- See which apps start with your computer and where they come from.
- Supported third-party items can be turned off and restored later.
- System items and sources that cannot be changed safely on the current platform are view-only.
- CoreRobin does not delete startup configuration files.

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

- Everyday Settings keeps language, text size, motion, desktop notifications, local history, and Robin companion preferences together.
- CoreRobin can launch quietly after system sign-in without opening the main window. On macOS, you can also choose whether it appears in the Dock and app switcher.
- Pro Settings also includes sampling rates, connection refresh, alert colors, and the default process view.

## Menu bar panel

Closing the main window leaves CoreRobin available in the menu bar. Click the menu bar icon to toggle a compact panel that shares the main window's current health conclusion; double-click it to open the main window directly. A quiet login launch does not show the splash screen or main window.

Choose Robin companion to open a compact bottom-right window that shares the same conclusion as the main window and menu bar panel, with one next step. Press Escape, use the close button, or click another window to dismiss it. Its dragged position is remembered, and Everyday Settings controls whether it stays on top or appears at startup.

To stop monitoring completely, quit CoreRobin instead of only closing the window.

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

The current installer is not Apple-notarized. If the first launch is blocked, confirm it in System Settings → Privacy & Security. If CoreRobin is missing from Full Disk Access, install `CoreRobin.app` in Applications and launch it from there, then use `+` below the list to choose it. The app can also reveal its location in Finder.

### macOS says CoreRobin is damaged. Should I use Open Anyway?

No. “Damaged” is not the normal unnotarized-developer prompt, and macOS may not offer Open Anyway for it. The v0.0.3 Apple Silicon DMG had an incomplete ad-hoc app-bundle signature and was replaced by v0.0.4. Delete the old DMG and app copy, download the latest Apple Silicon package, and verify it against `SHA256SUMS`. If the latest package still shows the same message, report the macOS version, Mac chip, CoreRobin version, and checksum result; do not remove quarantine attributes as a workaround.

### Can I scan without Full Disk Access?

Yes. Choose **Scan accessible areas** to continue with locations available to the current account and system. Protected or temporarily unreadable locations are identified in the result. The permission only makes the system-disk map more complete; scans still read metadata, not file contents.

### Is CoreRobin still running after I close the main window? How do I close Robin?

Yes. Closing the main window hides it while monitoring continues in the menu bar. Quit CoreRobin from the menu bar to stop monitoring. Dismiss the Robin companion with its close button, Escape, or its setting; dismissing Robin does not quit the app.

### How do I clear data or uninstall completely?

Use Records to clear saved history and Cleanup to clear a saved scan result. For a full uninstall, quit CoreRobin from the menu bar, clear those local records if desired, then use your operating system's application-uninstall flow. Do not attach local data folders, logs, or unredacted screenshots to a public Issue.

## Privacy and support

Monitoring, file, process, history, and connection data stay on this computer. They are not uploaded or synced. Scans read file information such as names, sizes, and locations, not file contents. See the [Privacy Notice](privacy.md) for retention, Full Disk Access, and data-clearing details.

For general problems, open a GitHub issue and include your operating system, what you were doing, and any error message. Use GitHub private vulnerability reporting for security issues.
