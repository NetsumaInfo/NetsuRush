# R01: Resolve OpenFX host contract

## Confirmed by specification/SDK

- Generator is the correct no-input context. [S-OFX-CONTEXTS]
- Render receives time, render window, and render scale and writes the output image. [S-OFX-RENDERING]
- Thread-safety capability is declared by the plugin. [S-OFX-THREADING]
- Resolve's local SDK contains OpenFX 1.4 headers, sample projects, and install paths. [S-BMD-OFX-README] [S-BMD-OFX-HEADERS]
- Multiline string parameters exist. [S-BMD-OFX-PARAMS]

## Unknown host behavior

- Exact render call ordering during Edit/Fusion scrubbing, thumbnail creation, cache generation, and Deliver.
- Whether Resolve issues subframe times or overlapping calls for this generator.
- Inspector behavior for large multiline strings, buttons, read-only status, and dynamically changing choices.
- Whether disabling tiles and host frame threading is respected as expected.
- Error propagation visible to the user.
- Plugin discovery from a user-defined `OFX_PLUGIN_PATH`.

## Required instrumentation

The host-proof plugin logs process ID, instance ID, action, time, render window, scale, thread ID, start/end timestamps, abort observation, and parameter revision. Logs go to the NetsuFlow user-data directory and contain no source code or tokens.

Implemented in `openfx/src/PluginLog.cpp` and enabled with `NETSUFLOW_OFX_LOG=1`, which must be set before Resolve starts. Each render line also carries the negotiated pixel depth and component count, which is what answers the depth question below.

## Settled by T00

- The bundle builds from a single non-interactive command, matches the documented Windows layout, and depends only on `WS2_32.dll` and `KERNEL32.dll`.
- Exports are `OfxGetNumberOfPlugins` and `OfxGetPlugin`. `OfxSetHost` is **not** exported, because the Support wrapper shipped with the SDK does not define it and the SDK's own samples behave the same way. Whether Resolve ever calls it is a T01 observation.
- `ofxsHWNDInteract.cpp` cannot be compiled from this SDK drop: it needs an `ofxHWNDInteract.h` the SDK does not ship, and the vendor samples exclude it too.

## Exit

T01, T02, and T07 produce versioned runtime reports. Only observed behavior should influence scheduling and UI decisions.
