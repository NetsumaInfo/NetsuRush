# OpenFX Generator design

## Role

The plugin is one engine-neutral image source. It must not contain HyperFrames,
Remotion, browser, package-manager, or project-discovery logic.

Use the Generator context with mandatory output and no required source clip.
[S-OFX-CONTEXTS]

## Stable identity

Keep `com.netsurush.netsuflow.generator` unchanged so future engine support does
not create another Resolve plugin identity. [S-NF-OPENFX] Rename only the
visible experimental label from `NetsuFlow Remotion (Experimental)` to
`NetsuFlow (Experimental)` when implementation work resumes. Historical T01
reports retain the old measured label.

## Host declarations

- Generator context;
- RGBA components;
- byte and float depths because T01 observed both in one Resolve session;
- tiles disabled initially;
- instance-safe rendering;
- no temporal clip access;
- host frame threading disabled until stress tests justify it.

[S-NF-T01] [S-OFX-THREADING]

## Inspector parameters

| Parameter | Purpose |
|---|---|
| Binding | Opaque NetsuRush-managed source identifier |
| Props JSON | Optional instance override; must affect a revision |
| Start frame | Host-to-source time offset |
| Source FPS | Explicit override only when required |
| Quality | Preview/final policy hint |
| Cache mode | Auto, bypass, refresh |
| Reload | Requests invalidation/reconnect |
| Status | Resolved engine, health, revision, and cache state |
| Diagnostic source | Developer-only multiline field |

The binding resolves the engine. No `HyperFrames project path` or `Remotion
project path` belongs in the plugin.

Composition-specific controls use a fixed typed bank declared with the plugin:
double, integer, Boolean, color, point, choice, and short-string slots. The
binding maps stable variable IDs to these slots, and the plugin reads every
mapped value with `getValueAtTime()` so one control supports both constants and
Fusion keyframes. Arbitrary new parameters cannot be defined after the plugin's
describe action. See [`12-fusion-parameter-binding.md`](12-fusion-parameter-binding.md).
[S-OFX-PARAMETERS]

## Render action

1. Read time, render window, render scale, parameters, and abort state.
2. Resolve exact source frame and output dimensions.
3. Compute the plugin last-frame key.
4. Send the engine-neutral request with a deadline.
5. Poll abort while waiting.
6. Validate dimensions, stride, length, format, alpha mode, and revision.
7. Convert host bit depth and copy only the requested window.
8. Release every host and response resource on all paths.

The current implementation already follows most of this sequence.
[S-NF-OPENFX] [S-NF-BRIDGE]

## Props correctness gap

The current plugin reads `Props JSON`, but `FrameRequest` carries only binding
and source revision, and the plugin `FrameKey` does not include props.
[S-NF-OPENFX] [S-NF-BRIDGE] Before real rendering, choose one of:

- preferred: NetsuRush creates a new binding revision for normalized props and
  the plugin cache keys the returned binding/source revision;
- optional instance override: add `propsRevision` and normalized props to a
  versioned request, with strict size limits.

Never key only on the raw JSON string: canonicalize and validate it in the
service.

## Error policy

Interactive failures return a bounded diagnostic or explicitly permitted
last-good frame. Final renders fail rather than silently using stale pixels.
Malformed service output is rejected before buffer access. The fake-service
suite remains the permanent host-safety regression layer. [S-NF-T03]

## Performance scope

Start CPU-only. Browser capture is already out-of-process; GPU interop cannot be
assumed to remove its dominant costs. Shared memory or GPU transfer is justified
only by measured copy/decode profiles.
