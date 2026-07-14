# Security policy

StatusOrbit is under active development. Security fixes are applied to the current `main` branch.

Please report a suspected vulnerability through GitHub's private vulnerability reporting feature rather than a public issue.

## Temporary upstream dependency exception

StatusOrbit temporarily accepts [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) (`RUSTSEC-2024-0429`) as a tolerable upstream risk.

- The affected `glib 0.18.5` package is a Linux-only transitive dependency of Tauri 2's GTK3 runtime.
- The affected `glib::VariantStrIter` iterator API is not called directly by StatusOrbit.
- The first patched release is `glib 0.20.0`, but Tauri 2.11.5 still constrains its GTK3 stack to `glib 0.18.x`; Cargo cannot resolve the patched major version without replacing Tauri's Linux runtime.
- Dependabot updates for `glib` are ignored until that upstream constraint changes, preventing repeated update jobs that cannot produce a valid lockfile.

This exception must be reviewed whenever Tauri, Wry, Tao, or the Linux GTK runtime is upgraded. Once the dependency graph accepts `glib >= 0.20`, remove the Dependabot ignore rule and close this exception by upgrading the lockfile.
