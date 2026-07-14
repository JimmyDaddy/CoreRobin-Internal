# StatusOrbit User Guide

StatusOrbit is a local-first desktop resource monitor that turns CPU, memory, storage, network, and process data into understandable status, causes, and next steps.

> Native windows and builds have been verified on macOS. Linux and Windows branches are continuously compiled in CI, but still need more runtime validation on target systems.

## Install and run

StatusOrbit is currently under active development and does not yet ship official installers. To build from source, install Node.js 22, pnpm 10.33, Rust 1.95, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, then run:

```bash
corepack enable
pnpm install
pnpm dev
```

Build the native application with `pnpm tauri build`.

## First run

1. Open Overview and wait for the first sampling cycle. Disk and network rates need two samples, so a short warm-up state is expected.
2. Keep Simple mode if you mainly want a plain-language answer. Switch to Pro mode for PIDs, commands, protocols, and detailed trends.
3. Open Settings to choose the language, sampling intervals, alert thresholds, history retention, and notification categories.

## Main areas

### Overview and diagnosis

Overview combines live resource data with cautious diagnosis. StatusOrbit waits for sustained evidence before raising a concern and never terminates a process or removes a file automatically.

### Applications and processes

Simple mode groups helper processes by application. Pro mode provides flat and tree layouts, search, sorting, virtualization, detailed metadata, and five-minute trends. Process actions use short-lived, single-use confirmations and revalidate process identity before execution.

### Storage and cleanup

Storage shows volume capacity, free space, I/O trends, and high-I/O processes. Cleanup performs a complete background scan with visible progress and cancellation.

- Click a sunburst sector to enter a folder and click the center to go back.
- Hold and drag a file or folder sector into the cleanup basket.
- Review names, paths, sizes, and changes before permanent deletion.
- Deletion does not use system Trash and cannot be undone in StatusOrbit.
- Home, Trash roots, links, special files, and cross-filesystem mount boundaries are protected.
- Successful items disappear from the map and retained cache immediately; failures remain highlighted in the basket.

Start with reproducible caches. Review downloads, settings, projects, and personal data carefully.

### Network

Inspect throughput, session totals, interfaces, and TCP/UDP connections. Process ownership is permission-dependent; a missing owner is not evidence of malicious activity.

### Startup items

Review common user startup sources. Supported third-party user items can be disabled and restored; system-owned or unsupported sources remain read-only. StatusOrbit verifies file identity before a change and does not delete the source file.

### History and alerts

Local five-minute snapshots record resource trends, sustained alerts, and recovery events. Retention can be set to 1, 7, or 30 days, disabled, or cleared. Sensitive command, path, filename, and connection details are not stored.

## Common questions

- **No disk or network rate after launch?** Wait for the next sample; rates require two cumulative counters.
- **Why can cleanup take a while?** It performs a complete scan without silent time or item limits. Large trees with many small files take longer.
- **Why does size differ from Finder or Explorer?** StatusOrbit prioritizes allocated disk space; sparse files, hard links, compression, and filesystem behavior affect the result.
- **Why are some connections missing process names?** The operating system may restrict ownership data. StatusOrbit does not elevate itself automatically.
- **Port 1420 is already in use during development?** Stop the earlier Vite/Tauri development process before launching another instance.

## Privacy and support

StatusOrbit does not upload telemetry, process data, files, history, or connections by default. Report security issues through GitHub private vulnerability reporting. Use GitHub Issues for general bugs and include the operating system, reproduction steps, and relevant error details.
