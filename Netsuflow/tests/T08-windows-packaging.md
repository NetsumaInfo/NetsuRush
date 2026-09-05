# T08: Windows installation and packaged runtime

## Question

Can the current-user NetsuRush product install, start, repair, update, and remove the complete renderer and OpenFX integration predictably?

## Clean-machine matrix

- standard user without developer Node/npm/CMake/Visual Studio;
- administrator and non-administrator accounts;
- ASCII, spaces, and non-ASCII paths;
- Resolve installed before/after NetsuRush;
- offline first run;
- Defender/antivirus observation;
- application update with Resolve open/closed.

## Installation variants

1. Primary: per-user bundle plus user-level `OFX_PLUGIN_PATH`.
2. Fallback experiment only if required: standard path through an elevated narrow helper.
3. Manual installation only as a prototype control.

The OpenFX search paths are defined by the packaging specification. [S-OFX-PACKAGING]

## Verify

- plugin discovery and restart messaging;
- packaged renderer dependency completeness;
- exact HyperFrames engine/adapter/lockfile version;
- exact browser executable and no surprise download;
- runtime manifest and checksums;
- install/repair/update/uninstall idempotence;
- preservation of unrelated OpenFX plugins/environment entries;
- cache removal as a separate operation;
- third-party notices and licensing inventory;
- no dependency on a global Node, npm, browser, or HyperFrames install;
- existing packaging tests extended for every new asset. [S-NR-DIST] [S-NR-PACKAGING-TEST]

## Pass

A clean supported machine works offline after installation, repair restores intentionally removed assets, an engine-adapter update does not require changing the OpenFX identifier, updates do not replace a loaded plugin, and uninstall removes only recorded NetsuFlow artifacts.
