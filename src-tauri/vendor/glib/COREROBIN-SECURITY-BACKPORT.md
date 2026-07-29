# CoreRobin security backport

This directory is the source of `glib 0.18.5` from crates.io with the package
version advanced to `0.18.6` for CoreRobin's local, vendored patch release.

It contains exactly the upstream-reviewed fix for
RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g:

- upstream PR: https://github.com/gtk-rs/gtk-rs-core/pull/2009
- reviewed commit: `ea720152f28e293ef4362ee844ee5cc499f32d2a`
- changed source: `src/variant_iter.rs`

The change makes the `g_variant_get_child` out-pointer binding mutable and
passes `&mut p`. Remove this vendored patch and return to crates.io when an
official compatible gtk-rs 0.18 patch release containing the same fix is
available.
