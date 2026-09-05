# NetsuFlow OpenFX host proof

Experimental OpenFX Generator built to answer T00–T03. It renders a deterministic
diagnostic frame, locally or through the bridge, and instruments what the host
does. It does not render HyperFrames or Remotion compositions and is not a shippable product.

## Requirements

- DaVinci Resolve Developer SDK (OpenFX 1.4 headers plus the C++ Support wrapper).
  Nothing from the SDK is copied into this repository.
- Visual Studio Build Tools 2022 with the C++ toolset and a Windows SDK.
- CMake 3.20 or newer.
- Node.js 22 or newer, for the bridge end-to-end test only.

Third-party OpenFX plugins load in **DaVinci Resolve Studio**; the free edition
does not load them.

## Build

```powershell
$env:DAVINCI_RESOLVE_DEVELOPER_DIR = 'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer'
cmake -S Netsuflow/openfx -B Netsuflow/openfx/build -A x64 -DNETSUFLOW_BUILD_TESTS=ON
cmake --build Netsuflow/openfx/build --config Release
```

The bundle lands at
`Netsuflow/openfx/build/Release/NetsuFlow.ofx.bundle`.

Configuration fails with an explicit message when the SDK is missing. The build
links the CRT statically and passes `/Brepro`, so the binary depends only on
`WS2_32.dll` and `KERNEL32.dll` and two clean builds of the same sources produce
byte-identical output.

## Test

```powershell
ctest --test-dir Netsuflow/openfx/build -C Release --output-on-failure
```

Four suites run: the diagnostic-frame contract, the wire protocol, the session
descriptor, and `BridgeEndToEnd`, which drives the real native client against the
real fake renderer over a loopback socket. The end-to-end suite issues 10,000
soak requests by default; lower it for a quick run:

```powershell
$env:NETSUFLOW_E2E_SOAK = '200'
```

The fake renderer's own unit tests run separately:

```powershell
npm --prefix Netsuflow/prototypes/fake-renderer test
```

## Install for a manual Resolve session

Resolve discovers plugins at startup and holds the binary open while running, so
**close Resolve before copying or removing anything**. Do not automate killing
the process.

Standard system-wide location, which requires an elevated shell:

```powershell
$source = (Resolve-Path 'Netsuflow\openfx\build\Release\NetsuFlow.ofx.bundle').Path
Copy-Item -LiteralPath $source -Destination 'C:\Program Files\Common Files\OFX\Plugins' -Recurse -Force
```

Per-user location, no elevation, which is also the T01 experiment for R6/T08:

```powershell
$plugins = "$env:LOCALAPPDATA\NetsuRush\ofx-plugins"
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item -LiteralPath (Resolve-Path 'Netsuflow\openfx\build\Release\NetsuFlow.ofx.bundle').Path -Destination $plugins -Recurse -Force
[Environment]::SetEnvironmentVariable('OFX_PLUGIN_PATH', $plugins, 'User')
```

Restart Resolve, then record in the T01 report whether the plugin was discovered.
`OFX_PLUGIN_PATH` is a semicolon-separated list on Windows: preserve any existing
value instead of overwriting it on a machine that has other plugins.

## Remove

```powershell
Remove-Item -LiteralPath 'C:\Program Files\Common Files\OFX\Plugins\NetsuFlow.ofx.bundle' -Recurse -Force
```

Remove only that exact directory. Never clear the whole plugins folder, and undo
an `OFX_PLUGIN_PATH` change by restoring the previous value rather than deleting
the variable.

## Instrumentation

Set `NETSUFLOW_OFX_LOG=1` before launching Resolve to log every action with its
time, render window, render scale, thread, negotiated depth, abort observation
and outcome:

```
%LOCALAPPDATA%\NetsuRush\netsuflow\logs\ofx-<pid>.log
```

Set the variable to a directory path to log elsewhere. The log records no source
text, props, tokens, or project paths.

## Parameters

| Parameter | Purpose |
|---|---|
| Binding | NetsuRush-managed project/composition identifier |
| Start Frame | Host frame that maps to composition frame 0 |
| Mode | `Local Diagnostic` (no service) or `Bridge` |
| Quality | `Preview` (2 s deadline, last-good fallback) or `Final` (30 s, no stale substitution) |
| Cache | Auto / Bypass / Refresh, forwarded to the service |
| Props | Multiline JSON, for the T02 Inspector matrix |
| Diagnostic Source | Multiline scratch field, for the T02 Inspector matrix |
| Reload | Drops the cached frame, reconnects, refreshes Status |
| Status | Read-only summary, written only from `changedParam` |

In Bridge mode the plugin reads the session descriptor written by the renderer
service, defaulting to
`%LOCALAPPDATA%\NetsuRush\netsuflow\session.json`. `NETSUFLOW_SESSION_FILE`
overrides it. The plugin always connects to `127.0.0.1`; the descriptor supplies
the port and token but never a host.

## Reading the diagnostic frame

The top band is a 16-cell binary counter: cell *i* is lit when bit *i* of the
frame number is set, least significant on the left. Read it to confirm the node
was asked for the frame you expect.

Below the band is a high-frequency repeating pattern, not a smooth gradient: the
channel ramps wrap every ~37 pixels horizontally and ~23 vertically, so the frame
looks tiled. That is deliberate — fine detail makes resampling, stride and
row-order bugs immediately visible, where a smooth gradient would hide them. It
does mean the image is busy to look at; the counter, not the pattern, is the part
meant to be read by eye.

The red channel of the first four pixels of the top row carries the frame number
as a big-endian integer, which is what the automated tests compare.
