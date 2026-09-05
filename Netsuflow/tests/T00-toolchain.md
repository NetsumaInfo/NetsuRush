# T00: Toolchain and reproducible bundle

## Question

Can the current Windows machine build a minimal Resolve-compatible OpenFX bundle from a clean command, and can the build inputs be described without relying on an interactive IDE state?

## Setup

- Resolve 21 Developer SDK from `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer`.
- Visual Studio Build Tools 2022 and a Windows SDK.
- CMake-generated Visual Studio project or an equivalent documented build.

## Procedure

1. Record compiler, CMake, SDK, host architecture, and Resolve SDK timestamps.
2. Configure a release x64 plugin build with an explicit SDK root.
3. Build twice, once from a clean directory.
4. Verify expected bundle layout and exported OpenFX entry points.
5. Record hashes and dependency inspection of the plugin binary.

## Pass

- One documented non-interactive command builds the bundle.
- The bundle has the Windows OpenFX layout described by the SDK. [S-BMD-OFX-README]
- No undeclared development-machine DLL is required.

## Fail

- Build requires an unavailable proprietary library beyond the Resolve SDK contract, or output cannot be loaded as a normal OFX binary.

This test does not install or launch Resolve.
