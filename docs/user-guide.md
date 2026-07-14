# StatusOrbit User Guide

StatusOrbit brings CPU, memory, storage, network activity, and running apps into one clear desktop view. When your computer slows down, storage runs low, or network activity spikes, it helps you find the cause.

> StatusOrbit does not have an official installer yet, so it currently runs from source. The app has been tested in real macOS windows and native builds. Linux and Windows are continuously compiled, but still need more testing on real devices.

## Run from source

If you are not comfortable with development tools, consider following the project until official installers are available. To run from source, you need:

- Node.js 22
- pnpm 10.33
- Rust 1.95
- The [Tauri 2 dependencies](https://v2.tauri.app/start/prerequisites/) for your operating system

Clone the repository and start the app:

```bash
git clone https://github.com/JimmyDaddy/StatusOrbit.git
cd StatusOrbit
corepack enable
pnpm install
pnpm dev
```

To build the desktop app, run:

```bash
pnpm tauri build
```

## First launch

1. Give the app a few seconds to collect its first readings. Disk and network speeds may show a warm-up message until the next refresh.
2. Start with Simple mode for everyday use. It shows whether your computer is doing well and which apps are busiest.
3. Switch to Pro mode when you need PIDs, connection protocols, command lines, or full trends.
4. Open Settings to change the language, refresh speed, alert colors, history retention, and notifications.

## Main pages

### Overview: see what is busy

- Overview puts CPU, memory, storage, and network activity in one place.
- StatusOrbit looks at recent trends before raising a concern, so a brief spike is not treated as a problem.
- Open any warning to see which app or resource is busiest.

### Apps and processes

- Simple mode groups related processes by app, making it easier to find what is using resources.
- Pro mode adds a process tree, search, sorting, file locations, launch commands, and five-minute trends.
- Prefer Request Stop so an app has time to save its work. Use Force Stop only when an app is completely unresponsive.
- StatusOrbit checks the target again before stopping it. If the process has exited or changed, the action stops.
- Critical system processes and StatusOrbit itself cannot be stopped by mistake.

### Storage

- See how much space is left on each disk, recent read and write activity, and which apps are using the disk heavily.
- On macOS, `/` and the Data volume are shown as one system volume when they belong to the same APFS volume group.
- When space is running low, open Cleanup directly from this page.

### Space cleanup

Cleanup scans files and folders, then uses a sunburst map to show what is taking up space.

1. **Let the scan finish:** The page shows where it is scanning, how many items it has checked, and how much space it has found. The scan continues until it finishes unless you stop it.
2. **Explore large folders:** Larger sectors use more space. Click a folder to open it, or click the center to go back.
3. **Add items to the basket:** Hold a sector and drag it to the lower-left basket. This only collects the item; it does not delete anything yet.
4. **Review, then delete:** Check that the name, location, and size are correct before continuing.

Scan results are kept on your device for a while, so returning to Cleanup does not immediately require another full scan. When you open a folder, StatusOrbit checks that level for changes and updates the map.

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

### History and notifications

- History records overall CPU, memory, storage, and network changes over time, so you can see when your computer became busy and when it recovered.
- Keep history for 1, 7, or 30 days, turn it off, or clear it anytime.
- Notifications appear only when a problem lasts for a while, and the same warning is not repeated constantly.
- CPU, memory, and storage notifications can be turned off separately.
- Command lines, file locations, filenames, and connection addresses are not stored by default.

## Menu bar panel

Closing the main window leaves StatusOrbit available in the menu bar. Open the menu bar panel for a quick look at CPU, memory, storage, and network activity, or to reopen the main window.

To stop monitoring completely, quit StatusOrbit instead of only closing the window.

## Common questions

### Why are disk and network speeds missing right after launch?

The app needs two readings to calculate a rate. The numbers appear after the next refresh.

### Why is the scan taking a long time?

Scan time depends mostly on the number of files and folders, not total disk size. Development caches, large numbers of small files, and restricted folders take longer. Progress keeps updating, and you can stop the scan.

### Why does the size differ from Finder or Explorer?

StatusOrbit shows the space files actually occupy on disk. Compression, sparse files, and hard links can make this number differ from the listed file size.

### Why are some connections missing app names?

The operating system may hide which process owns a connection. StatusOrbit does not elevate itself automatically to fill in that information.

### What if port 1420 is already in use during development?

An earlier Vite or Tauri process is probably still running. Stop the old development process before running `pnpm dev` again.

## Privacy and support

Monitoring, file, process, history, and connection data stay on this computer by default. They are not uploaded or synced.

For general problems, open a GitHub issue and include your operating system, what you were doing, and any error message. Use GitHub private vulnerability reporting for security issues.
