# T00 result — 2026-08-26

Status: PASS

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| CPU | AMD Ryzen 7 6800H |
| RAM | 27.7 GiB |
| GPU | NVIDIA GeForce RTX 3070 Ti Laptop (not exercised; this build is CPU-only) |
| Host architecture | x64 |

## Versions and revisions

| Item | Value |
|---|---|
| CMake | 4.2.3 |
| MSVC toolset | 14.44.35207 (Visual Studio 2022 Build Tools) |
| Compiler | cl.exe 19.44.35222.0 |
| Windows SDK | 10.0.26100.0 |
| Resolve Developer SDK | `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer`, README dated 2026-08-03 |
| OpenFX headers | OpenFX 1.4, from the SDK |
| Node.js | v22.16.0 (test only, not a build input) |
| Repository revision | `df44d4b`, `Netsuflow/` untracked at the time of the run |

## Commands

```powershell
$env:DAVINCI_RESOLVE_DEVELOPER_DIR = 'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer'
cmake -S Netsuflow/openfx -B Netsuflow/openfx/build -A x64 -DNETSUFLOW_BUILD_TESTS=ON
cmake --build Netsuflow/openfx/build --config Release
```

Both steps are non-interactive. No IDE state, no `.sln` opened by hand, no manual
copy of SDK files into the repository.

## Fixtures

None. T00 only builds; it does not install or launch Resolve.

## Results

### Bundle layout — PASS

```text
NetsuFlow.ofx.bundle/
  Contents/
    Resources/
    Win64/
      NetsuFlow.ofx
```

Matches the Windows layout described by the SDK README. [S-BMD-OFX-README]
[S-OFX-PACKAGING]

### Exported entry points — PASS

```text
OfxGetNumberOfPlugins
OfxGetPlugin
```

`OfxSetHost` is **not** exported. The Support wrapper shipped with the SDK does
not define it and the SDK's own sample plugins export the same two symbols, so
this matches the vendor baseline rather than indicating a defect. Whether Resolve
ever calls `OfxSetHost` is a T01 observation.

### Dependency inspection — PASS

Final dependency set:

```text
WS2_32.dll
KERNEL32.dll
```

The first build depended on `MSVCP140.dll`, `VCRUNTIME140.dll`,
`VCRUNTIME140_1.dll` and the UCRT `api-ms-win-crt-*` set — a Visual C++
redistributable requirement, which is exactly the "undeclared development-machine
DLL" T00 rules out. The build now links the CRT statically
(`CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`), which removes it. Nothing crosses
the plugin boundary that would object: the OpenFX ABI is C, and the host owns its
own image buffers.

### Reproducibility — PASS, better than required

`/Brepro` on both the compiler and linker replaces the PE timestamp and related
volatile fields with a content hash. Two clean builds from separate directories:

```text
buildA  9996B34DB53CF2678E7C101FD0496459439205DA8A5CBF6A2D97E35F4978AEEB
buildB  9996B34DB53CF2678E7C101FD0496459439205DA8A5CBF6A2D97E35F4978AEEB
```

Byte-identical. T00 only asked that a clean build succeed twice; determinism is a
stronger result and it makes the checksums in the packaging contract meaningful.
[S-NR-DIST]

### Binary

| Item | Value |
|---|---|
| Path | `Contents/Win64/NetsuFlow.ofx` |
| Machine | x64 (8664) |
| Size | 436,224 bytes (static CRT; 197,632 with the dynamic CRT) |
| SHA-256 | `9996B34DB53CF2678E7C101FD0496459439205DA8A5CBF6A2D97E35F4978AEEB` |

The hash above is from the `NETSUFLOW_BUILD_TESTS=OFF` reproducibility pair.
Enabling tests does not change the plugin's own sources, but the hash should be
re-recorded from the exact configuration that gets installed.

### Unit tests — PASS

```text
DiagnosticFrameTests ... Passed
ProtocolTests .......... Passed
SessionDescriptorTests . Passed
```

Compiled with `/W4 /WX /permissive-`. The build emits no warnings.

## Failures and observations

1. **The VC redistributable dependency was real and was fixed, not waived.**
   Recorded because a future change that reintroduces a dynamic CRT would
   silently reintroduce a deployment prerequisite.
2. **`ofxsHWNDInteract.cpp` is not buildable from this SDK drop.** It references
   `kOfxHWndInteractPropLocation` and `gHWNDInteractSuite`, which come from an
   `ofxHWNDInteract.h` header the SDK does not ship. The SDK's own sample
   projects do not compile it either, so `FindResolveOpenFX.cmake` mirrors the
   vendor's translation-unit list exactly.
3. **CMake 4.x compatibility.** `cmake_minimum_required(VERSION 3.20)` is used;
   CMake 4 rejects projects declaring compatibility below 3.5.
4. **No SDK files were copied into the repository.** The build resolves them
   through `DAVINCI_RESOLVE_DEVELOPER_DIR` or the default install path, which
   keeps the licence question in `docs/09` open rather than pre-empting it.

## Decision

T00 passes. The machine can build a Resolve-compatible OpenFX bundle from a
single non-interactive command, the layout matches the SDK contract, the binary
requires no undeclared DLL, and the build is bit-for-bit reproducible.

## Follow-up

- Re-record the SHA-256 from the exact configuration that is installed for T01.
- T01 must record whether Resolve calls `OfxSetHost` and which pixel depth it
  actually negotiates.
