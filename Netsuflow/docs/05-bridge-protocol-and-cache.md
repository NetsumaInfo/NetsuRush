# Bridge protocol, scheduling, and cache

## Principle

The wire contract transports frames for bindings, not requests for a named
renderer. The existing native request already uses `binding` and
`sourceRevision`, so HyperFrames can be added without an immediate protocol
fork. [S-NF-BRIDGE] [S-NF-PROTOCOL]

## Minimal messages

```text
HELLO(version, token, client, instance)
HELLO_OK(version, service_instance, capabilities)
DESCRIBE(binding, props_revision)
FRAME(request_id, binding, source_revision, frame, width, height,
      render_scale, pixel_format, alpha_mode, quality, deadline)
FRAME_OK(request_id, resolved_revision, timing, metadata, payload)
CANCEL(request_id)
INVALIDATE(binding, expected_revision)
PING / PONG
ERROR(request_id, code, retryable, message)
```

The engine ID is normally resolved from the binding. It may appear in diagnostic
metadata, but the plugin must not dispatch on it.

## Transport

| Candidate | Initial role |
|---|---|
| Framed raw RGBA over loopback TCP | Existing and primary bridge |
| PNG in memory/file | Engine correctness and disk-cache representation |
| HTTP/WebSocket | Control/dev service, not necessary for bulk pixels |
| Named pipe/Unix socket | Optional later platform adapter |
| Shared memory | Only after profiling |
| In-process engine | Rejected for host safety |

Loopback TCP is portable through Node's networking API; named pipes and file
mapping remain later platform options. [S-NODE-NET] [S-WIN-NAMED-PIPES]
[S-WIN-FILE-MAPPING]

## Canonical cache key

```text
hash(
  protocol_version,
  engine_id,
  engine_adapter_version,
  engine_package_version,
  browser_build,
  project_revision,
  composition_id,
  props_revision,
  normalized_props_hash,
  control_schema_revision,
  effective_control_values_hash,
  frame,
  width,
  height,
  render_scale,
  quality,
  pixel_format,
  color_policy,
  alpha_policy
)
```

This is deliberately larger than the current plugin key. Time or binding alone
cannot guarantee correctness.

Keyframed Fusion controls are sampled at render time. The plugin transmits a
bounded typed value set plus its canonical hash; the service revalidates the
values against the binding schema. A slider or keyframe change must invalidate
the plugin last-frame entry as well as service memory/disk entries.

## Cache layers

1. **Plugin last-frame cache** for repeated host calls and permitted last-good
   output. T01 observed 21 requests for one frame. [S-NF-T01]
2. **Decoded RGBA memory LRU** shared by engines.
3. **Encoded disk cache**, initially PNG, written atomically.
4. **Optional complete pre-render artifact** for expensive compositions.

Engine sessions are not cache entries. A session can be restarted while
content-addressed frames remain valid; an engine/browser version change changes
the key.

## Scheduling

- Deduplicate identical in-flight keys.
- Separate interactive and final queues.
- Prioritize requested frames over prefetch.
- Prefetch only after a directional pattern is observed.
- Cancel obsolete interactive work when no consumer remains.
- Bound browsers, pages, outstanding requests, memory, disk, payload, and time.
- Never silently downgrade a final request.

## HyperFrames pixel path

```text
captureFrameToBuffer(PNG)
  -> validate encoded size
  -> decode
  -> normalize RGBA8 straight
  -> memory cache
  -> existing framed bridge
```

`captureFrameToBuffer()` provides an in-memory encoded buffer, not a documented
raw RGBA result. [S-HF-FRAME-CAPTURE-SOURCE] A raw screenshot or shared-memory
optimization is allowed only behind the same normalizer after benchmarks.

## Backwards compatibility

Protocol additions are append-only within a negotiated version. Older plugin and
newer service pairs either agree on capabilities or return a precise mismatch;
they never guess. Engine adapter releases must not force an OpenFX update unless
the host-facing frame contract itself changes.
