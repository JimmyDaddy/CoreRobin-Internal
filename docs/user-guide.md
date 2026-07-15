# StatusOrbit User Guide

StatusOrbit brings CPU, memory, storage, network activity, and running apps into one clear desktop view. When your computer slows down, storage runs low, or network activity spikes, it helps you find the cause.

## Download and install

Download the package for your platform from [GitHub Releases](https://github.com/JimmyDaddy/StatusOrbit/releases/latest). The macOS build has been tested on real hardware, but the first release is not Apple-notarized. If macOS blocks the first launch, open System Settings → Privacy & Security and confirm that you want to open StatusOrbit. Windows and Linux packages are currently early previews.

## First launch

1. Give the app a few seconds to collect its first readings. Disk and network speeds may show a warm-up message until the next refresh.
2. Choose Simple mode in the upper-right corner to see whether your computer is healthy and which app is busiest.
3. Switch to Pro mode in the upper-right corner when you need to inspect a process, connection, or command line.
4. Open Settings to change the language, refresh speed, alert colors, history retention, and notifications.

## Main pages

### Overview

- Overview puts CPU, memory, storage, and network activity in one place.
- StatusOrbit looks at recent trends before raising a concern, so a brief spike is not treated as a problem.
- Open any warning to see which app or resource is busiest.

### Apps

- Simple mode groups related processes by app, making it easier to find what is using resources.
- Pro mode adds a process tree, search, sorting, file locations, launch commands, and five-minute trends.
- Prefer Request Stop so an app has time to save its work. Use Force Stop only when an app is completely unresponsive.
- StatusOrbit checks the target again before stopping it. If the process has exited or changed, the action stops.
- Critical system processes and StatusOrbit itself cannot be stopped by mistake.

### Storage

- See how much space is left on each disk, recent read and write activity, and which apps are using the disk heavily.
- On macOS, `/` and the Data volume are shown as one system volume when they belong to the same APFS volume group.
- When space is running low, open Cleanup directly from this page.

### Cleanup

Cleanup scans files and folders, then uses a sunburst map to show what is taking up space.

> Delete only items you recognize and know you no longer need. Leave anything you are unsure about. Re-creatable caches are a useful starting point, but not every cache is automatically safe to remove.

1. **Let the scan finish:** The page shows where it is scanning, how many items it has checked, and how much space it has found. The scan continues until it finishes unless you stop it.
2. **Explore large folders:** Larger sectors use more space. Click a folder to open it, or click the center to go back.
3. **Add items to the basket:** Hold a sector and drag it to the lower-left basket. Adding an item to the basket does not delete or move it.
4. **Review, then delete:** Check that the name, location, and size are correct before continuing.

Full scan results stay on this computer for 7 days, so returning to Cleanup does not immediately require another scan. When you open a folder, StatusOrbit checks that level and updates the map. Choose Rescan when many files have changed elsewhere.

#### Before permanent deletion

- Files bypass system Trash and cannot be restored by StatusOrbit.
- Start with caches that can be recreated. Do not delete downloads, project files, settings, or personal data unless you know you no longer need them.
- StatusOrbit removes only regular files and folders inside your home folder.
- Your home folder, Trash itself, links, special files, and other disks are protected.
- The app checks each item again right before deletion. If something has changed, the action stops.
- Deleted items disappear from the map and basket. Items that could not be deleted remain visible with an explanation.

### Network

- See current upload and download speeds, traffic since launch, network interfaces, and active connections.
- Filter connections by TCP, UDP, and connection state.
- The operating system may hide which process owns a connection. A missing app name does not mean the connection is suspicious.

### Startup items

- See which apps start with your computer and where they come from.
- Supported third-party items can be turned off and restored later.
- System items and sources that cannot be changed safely on the current platform are view-only.
- StatusOrbit does not delete startup configuration files.

### History

- History records overall CPU, memory, storage, and network changes over time, so you can see when your computer became busy and when it recovered.
- Keep history for 1, 7, or 30 days, turn it off, or clear it anytime.
- Notifications appear only when a problem lasts for a while, and the same warning is not repeated constantly.
- CPU, memory, and storage notifications can be turned off separately.
- Command lines, file locations, filenames, and connection addresses are not stored.

### Settings

- Change the language, system sampling rate, connection refresh rate, alert colors, and default app view.
- Choose how long to keep history and turn CPU, memory, and storage notifications on or off separately.
- Shorter refresh intervals respond faster but use slightly more system resources.

## Menu bar panel

Closing the main window leaves StatusOrbit available in the menu bar. Open the menu bar panel for a quick look at CPU, memory, storage, and network activity, or to reopen the main window.

To stop monitoring completely, quit StatusOrbit instead of only closing the window.

## Common questions

### Why are disk and network speeds missing right after launch?

The app needs two readings to calculate a rate. The numbers appear after the next refresh.

### Why is the scan taking a long time?

Scan time depends mostly on the number of files and disk speed, not total disk size. Many small files usually take longer than a few large files. Progress keeps updating, and you can stop the scan.

### Why does the size differ from Finder or Explorer?

StatusOrbit shows the space files actually occupy on disk. Compression, sparse files, and hard links can make this number differ from the listed file size.

### Why are some connections missing app names?

The operating system may hide which process owns a connection. StatusOrbit does not elevate itself automatically to fill in that information.

## Privacy and support

Monitoring, file, process, history, and connection data stay on this computer. They are not uploaded or synced. Scans read file information such as names, sizes, and locations, not file contents.

For general problems, open a GitHub issue and include your operating system, what you were doing, and any error message. Use GitHub private vulnerability reporting for security issues.
