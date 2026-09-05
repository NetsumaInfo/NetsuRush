# R04: OpenFX installation

## Known

The standard paths are `C:\Program Files\Common Files\OFX\Plugins` on Windows and `/Library/OFX/Plugins` on macOS. OpenFX also defines `OFX_PLUGIN_PATH` as an additional search path. [S-OFX-PACKAGING] The Resolve SDK documents the standard bundle locations. [S-BMD-OFX-README]

NetsuRush's current Windows installer is current-user, so writing to the standard Windows path normally requires elevation. [S-NR-DIST] T01 has since confirmed that Resolve Studio 21 discovers the current bundle through a user-scope `OFX_PLUGIN_PATH`, so that is the active product candidate. [S-NF-T01]

## Candidate Windows strategies

1. Active: a per-user bundle directory added through user-level `OFX_PLUGIN_PATH`, already confirmed on the current Resolve Studio 21 machine.
2. Fallback only: a narrowly scoped elevated install/repair helper for hosts that fail the supported per-user matrix.
3. Developer control: documented manual copy.

Do not silently mutate machine-wide environment variables. Any environment-based strategy must be reversible, preserve existing path entries, and explain that Resolve needs restart.

## Required tests

- clean current-user install with no admin;
- elevated standard install;
- discovery via user-level `OFX_PLUGIN_PATH` across supported Resolve versions;
- spaces and non-ASCII user paths;
- repair and version replacement with Resolve closed/open;
- uninstall without touching unrelated plugins;
- Resolve restart/discovery behavior.

## macOS

System plugin installation, architecture, signing, notarization, and engine/browser packaging require a separate real-Mac test. [S-OFX-PACKAGING]

## Exit

T08 validates repair/update/removal and supported-version coverage for the measured per-user strategy. It reopens elevation only if a supported host fails that matrix. T09 is mandatory before any macOS compatibility claim.
