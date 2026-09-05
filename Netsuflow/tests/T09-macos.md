# T09: macOS validation

## Prerequisite

A supported physical Mac with Resolve, Xcode toolchain, signing identity for release tests, and both target architectures or representative hardware. Windows-only inference is not evidence.

## Validate

- compile and bundle layout;
- arm64/x86_64 or per-architecture strategy;
- Resolve plugin discovery and Inspector behavior;
- loopback protocol, permissions, and session descriptor;
- packaged Node/HyperFrames-adapter/browser architecture;
- color, alpha, timing, cache, concurrency, sleep/resume;
- plugin/application signing, hardened runtime, notarization, install, repair, update, and removal;
- no unexpected browser download.

OpenFX documents the standard macOS bundle location. HyperFrames' engine manifest and browser dependencies must be validated on the actual packaged architecture. [S-OFX-PACKAGING] [S-HF-PACKAGE]

## Pass

All Windows-equivalent functional and safety gates pass on macOS, and a signed/notarized installation works on a clean machine.

Until this report passes, documentation must say “Windows first; macOS planned,” not “cross-platform.”
