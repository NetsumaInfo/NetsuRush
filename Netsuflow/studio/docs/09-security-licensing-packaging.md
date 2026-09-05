# Security, licensing, and packaging

## Trust boundary

HyperFrames and Remotion projects can execute JavaScript in a browser context.
Opening a project is therefore an execution decision, not merely reading a
document.

Untrusted projects do not preview, render, install dependencies, access the
network, or run agent tools until the user trusts the project root.

## Project server

The existing NetsuFlow renderer research already requires a hardened project
server. Studio uses the same principles:

- loopback-only bind;
- per-session unguessable token;
- canonical path and realpath containment;
- bounded requests and response sizes;
- explicit MIME types;
- no directory listing;
- no credential-bearing URLs in logs;
- separate origin/capability for preview content;
- clean shutdown and token rotation.

The iframe cannot call NetsuRush RPC directly.

## Network policy

Project network access is explicit and visible:

- offline/default-deny for deterministic local projects;
- allowlisted remote origins only after user approval;
- downloads stored through managed assets with checksums;
- no implicit CDN dependence for final renders;
- preview and render use the same resolved asset manifest.

## Source mutation safety

- Validate project root containment on every path.
- Write through atomic temporary-file replacement where appropriate.
- Preserve line endings and encoding.
- Keep base revision and source hash.
- Generate inverse patches or a recoverable snapshot.
- Refuse stale writes and present a three-way conflict.
- Never run formatter-wide rewrites as a side effect of one visual edit.

## Agent safety

Agent proposals run in a candidate session. The AI does not receive unrestricted
shell, network, filesystem, or Resolve access for normal authoring. Applying
source changes and publishing to Resolve are distinct user decisions. See
[`07-ai-agent-redesign.md`](07-ai-agent-redesign.md).

## Dependency and process isolation

- HyperFrames/Remotion packages load only inside engine workers.
- Exact versions and public export fingerprints are recorded.
- Browser and FFmpeg builds are pinned and checksummed.
- Unexpected downloads during preview/render are errors.
- Worker crashes do not terminate core RPC or the OpenFX host.
- Resource limits cover browser pages, memory, render concurrency, frame size,
  output size, duration, and agent preview quotas.

## Licensing

HyperFrames' repository is Apache-2.0. Exact redistributed npm tarballs and
transitive dependencies still require release-time inventory. [ST-HF-LICENSE]

NetsuRush is AGPL-3.0-only. Third-party notices, source obligations, trademarks,
and package-specific licenses must be satisfied by the final bundle. Remotion
requires a separate licensing gate. [ST-NR-DIST] [ST-REM-LICENSING]

No source is copied from another project merely because it is visible on
GitHub. Reuse follows its license, attribution, NOTICE, and modification rules.

## Packaging

Studio adds runtime dependencies only after T01 freezes the required surface.
Every dependency updates:

- npm lockfile and license inventory;
- Tauri resources/staging script;
- first-run/repair checks;
- offline behavior;
- uninstall manifest;
- version/diagnostics display;
- packaging tests.

The first Windows product proof comes before macOS claims. macOS remains a
separate runtime, OpenFX install, signing, browser, and Resolve test gate.

