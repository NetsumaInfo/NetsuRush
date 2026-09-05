# T07 - Packaged product validation

## Decision

Can the selected architecture be installed, updated, repaired, secured, licensed, and used offline as part of the NetsuRush Tauri application on Windows and macOS?

Tauri documents bundled resources and external binaries. NetsuRush currently packages portable Node and its core as resources, and its distribution contract requires staging, repair, runtime import/run checks, and packaging tests for every new dependency. [S-TAURI-SIDECAR] [S-TAURI-CONFIG] [S-NR-DIST]

## Packaging candidates

- P1: package Remotion packages and a compatible browser inside NetsuRush resources.
- P2: package Remotion packages but provision the browser during setup/repair.
- P3: OGraf-only live package plus official renderer fallback resources.
- P4: install a Fuse or OpenFX component in the user's Resolve/Fusion directories.

No candidate may depend on globally installed npm, Node, Chrome, Python, or developer tooling.

## Windows procedure

1. Build only when explicitly authorized and the running-app constraint permits it.
2. Audit staged resources for Node, Remotion, browser, OGraf, Fuse/OpenFX, templates, fonts, and licenses.
3. Install on a clean Windows user/machine image without developer tools.
4. Disable network access after installation.
5. Run composition discovery, T01 simple render, accepted live path, Fusion insertion, and final export.
6. Run repair after deleting one staged component at a time.
7. Upgrade from the prior release and verify caches/configuration migration.
8. Uninstall and verify which user caches and Resolve components remain by policy.
9. Check Authenticode/updater signatures and antivirus behavior for browser/native components.
10. Repeat under a non-admin user and paths containing spaces and non-ASCII characters.

## macOS procedure

1. Build the equivalent signed/notarized application package.
2. Verify universal/native architecture requirements for browser and any OpenFX component.
3. Install without developer tools or global Node/npm.
4. Repeat the offline render, live path, insertion, export, repair, upgrade, and uninstall scenarios.
5. Compare OGraf performance with the Windows baseline; Blackmagic documents Metal capture on macOS and CPU readback on Windows. [S-BMD-OGRAF-INTEGRATION]

## Security procedure

- Verify only explicitly trusted local project roots can execute.
- Do not automatically run package-manager installation for an opened project.
- Verify path traversal and symlink/junction escapes are rejected.
- Verify loopback APIs require a per-session token.
- Verify request sizes, render concurrency, cache size, and execution time are bounded.
- Verify logs redact props or environment values that may contain secrets.
- Test renderer crash, malformed project, hostile infinite render, and disk exhaustion.
- Verify OGraf packages do not require remote scripts, fonts, or assets.

## Licensing procedure

1. Record all shipped packages, browsers, fonts, native binaries, and their licenses.
2. Recheck Remotion's current license for the exact NetsuRush organization size and automated-product behavior. [S-REM-LICENSING]
3. Obtain written clarification before public/paid distribution if the product category is ambiguous.
4. Add required notices and source offers consistent with NetsuRush's AGPL distribution obligations.
5. Reject assets or runtime dependencies that cannot be redistributed under the intended installer model.

## Required evidence

- installed file manifest and hashes;
- installer-size delta;
- clean-install, offline, repair, upgrade, and uninstall reports;
- packaged-runtime smoke-test logs;
- platform and architecture matrix;
- signing/notarization/antivirus reports;
- dependency license inventory and Remotion licensing decision;
- cache location, quota, and cleanup behavior.

## Pass gates

- Accepted path works from a clean offline installation.
- Setup/repair detects and restores every required runtime component.
- No global developer dependency is required.
- Upgrade does not orphan incompatible caches or host plugins.
- Uninstall behavior matches documented user-data retention policy.
- Loopback and project-root security tests pass.
- Windows and macOS have an explicit supported-mode matrix.
- Licensing is confirmed before public or paid release.

## Product decision effect

- Full pass: architecture is eligible to ship.
- Platform-specific pass: ship an explicit capability matrix and retain Render fallback.
- Packaging failure: architecture remains experimental regardless of development-machine success.
- Licensing failure: do not ship the affected Remotion-powered mode.
