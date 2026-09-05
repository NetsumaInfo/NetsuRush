# T03 result — 2026-08-26

Status: CONDITIONAL — out-of-host PASS, in-host core path PASS, some rows still open

The out-of-host half passes with measured evidence: 28 automated scenarios, an
independent adversarial review, and a 10,000-request soak.

The in-host half was then run in DaVinci Resolve Studio 21 and its core path
passes too — see `## In-host results`. What remains open is listed under
`## Not run`, and the most important item there is that **Resolve has never once
asked this node to abort**, so cancellation is unproven as a protection and the
deadline is doing all the work.

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| CPU | AMD Ryzen 7 6800H (8C/16T) |
| RAM | 27.7 GiB |
| Storage | local NVMe |
| Node.js | v22.16.0 |
| Build | Release, MSVC 14.44.35207, static CRT, `/Brepro` |
| Plugin SHA-256 | `F24D52899C7EC0293B6944015D4765F69E7D62D6D9E3EA426B88F1F6534C86AB` (build carrying the frame cache and the connect backoff) |
| Repository revision | `df44d4b`, `Netsuflow/` untracked |

The fake renderer is single-threaded JavaScript on the same machine as the
client. Every latency below therefore includes Node scheduling and Windows
loopback, and is a floor-establishing measurement rather than a verdict on the
production transport.

## Commands

```powershell
$env:NETSUFLOW_E2E_SOAK = '10000'
ctest --test-dir Netsuflow/openfx/build -C Release --output-on-failure
npm --prefix Netsuflow/prototypes/fake-renderer test
```

## Fixtures

`makeDiagnosticFrame(width, height, frame)`, implemented independently in C++
(`openfx/src/DiagnosticFrame.cpp`) and JavaScript
(`prototypes/fake-renderer/diagnosticFrame.mjs`). Both suites pin the same
literal golden pixels, and the end-to-end run compares the two implementations
byte for byte. That equality is what proves the pixels survived the bridge
unaltered without Remotion being involved.

## Raw artifacts

- `bridge-e2e.log` — full scenario transcript from the measured run.
- `ctest.log` — CTest output.

## Results

### Automated suites — PASS

```text
DiagnosticFrameTests ... Passed
ProtocolTests .......... Passed
SessionDescriptorTests . Passed
BridgeEndToEnd ......... Passed   (28 scenarios, 0 failures)
fake-renderer .......... 25 tests, 25 pass, 0 fail
```

### Latency, 1080p RGBA8 (8,294,400 bytes per frame)

| Scenario | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| Cache hit, same frame repeatedly | 2,000 | 4.57 ms | **6.92 ms** | 26.33 ms |
| Sequential scrub, frames 0-119 | 120 | 11.22 ms | 24.60 ms | — |
| Random access, bounded service cache | 10,000 | 11.08 ms | 21.13 ms | 31.69 ms |

The provisional target in `docs/10` is a cache-hit p95 under 20 ms at 1080p. The
measured cache-hit p95 is **6.92 ms — target met**, with roughly 3x headroom.

The distinction matters and was initially got wrong: the first measurement mixed
the two paths and reported a p95 of 25-28 ms, apparently missing the target. That
run had no service-side cache, so every request regenerated 8.3 MB of pixels in
JavaScript. Adding a bounded cache to the fake renderer separated frame
generation from transport, which is the split the target is actually drawn
around. The cache-miss numbers above are the *fake generator's* cost and say
nothing about Remotion's.

The p99 of 26 ms against a p95 of 7 ms is a long tail from Node's single-threaded
event loop and Windows loopback scheduling, not from the client.

4K RGBA8 (33,177,600 bytes) was exercised for correctness; its pixels match the
fixture exactly.

### Resource stability — PASS

Across the 10,000-request soak, in the client process:

| Metric | Start | End |
|---|---:|---:|
| Working set | 4,568 KiB | 4,760 KiB |
| Handle count | 93 | 93 |

192 KiB of growth over 10,000 requests, each allocating and releasing an 8.3 MB
buffer, and no handle growth at all. This satisfies the "memory and handle counts
stabilize" criterion.

### Hostile-service matrix — PASS

Every scenario ends in a bounded, explicit refusal. No hang, no crash, and in no
case do unvalidated bytes reach the output buffer.

| Fault | Client outcome | Elapsed |
|---|---|---:|
| Wrong authentication token | `HandshakeFailed` | 33 ms |
| Bad header magic | `ProtocolError` | 57 ms |
| Unsupported protocol version | `ProtocolError` | 35 ms |
| Unknown message type | `ProtocolError` | 38 ms |
| Response carries the wrong request id | `ProtocolError` | 42 ms |
| Metadata that does not parse | `ProtocolError` | 46 ms |
| Dimensions differ from the request | `ProtocolError` | 41 ms |
| Stride smaller than one row | `ProtocolError` | 43 ms |
| Frame number differs from the request | `ProtocolError` | 44 ms |
| Body shorter than the declared length | `Timeout` | 5,030 ms |
| Declared body larger than what is sent | `Timeout` | 5,042 ms |
| Disconnect right after the header | `Disconnected` | 34 ms |
| Disconnect before any response | `Disconnected` | 34 ms |
| Explicit service error | `ServiceError` | 32 ms |
| Service never responds | `Timeout` | 5,042 ms |
| Body stalled after the header | `Timeout` | 5,026 ms |
| Long advisory `revision` (4 KiB) | `Ok`, field capped at 128 chars | — |
| Absurd advisory `revision` (60 KiB) | `ProtocolError` | — |
| Slow header, inside the deadline | `Ok` | — |
| Host abort raised during a 5 s stall | `Aborted` | 28 ms |
| Missing session descriptor | `NotConfigured` | 13 ms |
| Descriptor present, service gone | refused | 13 ms |
| Close and reconnect, same client | `Ok` then `Ok` then `Ok` | — |

Truncated and over-declared bodies resolve as `Timeout` rather than an immediate
`ProtocolError` because the client is still waiting for bytes the service
promised in the header. That is correct behaviour — the deadline is the backstop
for a service that lies about a length and then goes quiet — and it is bounded by
the 5 s request deadline, not by anything unbounded.

### Independent adversarial review — 2 confirmed defects, fixed

A separate reviewer worked the parsing boundary against the same threat model and
found real bugs. All were fixed and each is now pinned by a test.

1. **`decodeFrameMetadata` was falsely `noexcept`** while copying attacker-sized
   strings, most notably the advisory `revision` field, which no schema rule
   bounded. A `std::bad_alloc` there would reach `std::terminate()` **before** the
   OpenFX Support wrapper's catch-all could convert it into a status code —
   strictly worse than an exception escaping, because it kills the host with no
   unwinding. Fixed with a function-try-block plus a 128-character cap on
   `revision`. The same class of bug existed in `PluginLog`, whose `noexcept`
   accessor ran an allocating `call_once` and was reachable from a destructor
   (destructors are implicitly `noexcept`). Both fixed.
2. **An abort during a partial `send()` left a truncated message on a connection
   that stayed open.** Every other exit from that loop closed the socket; the
   abort path did not, contradicting the policy the same file documents and
   implements correctly for the read side. A service that regulates its read rate
   could arrange the short write, wait for a routine scrub abort, and then own the
   framing for the rest of the session against a predictable request-id counter.
   Not memory-unsafe — responses are still fully revalidated — but a real
   robustness defect. Fixed by dropping the connection, matching the read side.
3. **`changedParam` mutated state that `render()` reads**, from the UI thread.
   `eRenderInstanceSafe` only serialises render calls against each other and says
   nothing about `instanceChanged` arriving mid-render, so `lastGoodPixels_.clear()`
   could free a buffer a render was copying, and `bridge_->close()` could close a
   socket another thread was blocked reading. Rated plausible rather than
   confirmed because it depends on Resolve's dispatch threading. Resolved by
   removing the sharing rather than locking it: `changedParam` now only raises an
   atomic flag and `render()` performs the invalidation on its own thread.
4. Also fixed: Winsock signals a *failed* async connect through `exceptfds`, not
   `writefds`, so a refused connection burned the full 1 s timeout on a render
   thread every frame and reported "timed out" instead of "refused";
   `readExact` could spin a host-owned core for up to 30 s on a
   `select`-ready/`recv`-EWOULDBLOCK cycle; the repack loop hardcoded 4 bytes per
   pixel while validation used the negotiated format; and `lastGoodPixels_` could
   retain 1 GiB per instance, now capped at 4K.

The reviewer separately confirmed clean, having tried and failed to break them:
the render-window copy loop's bounds and bottom-up row flip, the JSON escape and
surrogate handling, every attacker-influenced allocation being gated before the
allocation, the 32-bit `size_t` overflow paths, and the buffer swap's lifetime.

## In-host results — 2026-08-27

Run in DaVinci Resolve Studio 21 against the fake renderer, with the node's
`Mode` set to `Bridge`. Log archived alongside the T01 report.

The session traced a full failure-and-recovery cycle without touching Resolve:

| Elapsed | Outcome | What was happening |
|---:|---|---|
| 138-144 s | `bridge: session descriptor not found` | Service not started; node shows the error colour |
| 257 s | **`bridge`** | Service up: pixels rendered, **visually identical to Local Diagnostic** |
| 368 s | `bridge: send failed` | Service killed mid-session; the plugin still held an open socket, the write failed, and it dropped the connection |
| 370-379 s | `bridge: connect timed out` | Descriptor still on disk, nothing listening |
| 802 s | **`bridge`** | Service restarted on a **new port and token**: the node reconnected on its own |

**Every T03 in-host pass criterion that this covers is met.** Resolve never
crashed, never hung, and never needed restarting. Invalid or absent pixels always
surfaced as the saturated error colour, never as a corrupt or stale frame.
Reconnection after a restart required no Resolve restart, which is the criterion
stated verbatim in `tests/T03-fake-service-ipc.md`.

The `send failed` line is worth keeping: it is the stale-socket path, where the
peer is gone but the connection object is not yet aware. The client discovered it
on the write, closed, and reconnected on a later render. That path had been
reasoned about but never observed.

### Connect backoff — a defect this session exposed

While the service was down, each Bridge render re-dialled and paid the full 1 s
connect timeout. The project owner reported the scrub as *not* laggy, which
contradicted the log; measuring settled it:

- Windows takes **~2.1 s** to refuse a loopback connection to a closed port, since
  it retransmits the SYN. The plugin's 1 s deadline therefore always fires first,
  which is why the log says `connect timed out` and not `connect refused`. The
  message is accurate and the `exceptfds` fix is correct; the OS is simply slower
  than the client's patience.
- The real defect was the retry cost: 1 s of a host render thread **per frame**,
  for as long as the service is down. Only two Bridge renders happened here, which
  is why it went unnoticed.

A failure backoff was added: 250 ms doubling to a 2 s cap, cleared by a successful
connect or by `Reload`. Measured with a dead service:

| Scenario | Before | After |
|---|---:|---:|
| 20 consecutive renders, service dead | ~20,000 ms | **1,019 ms** |
| 20 consecutive renders, no descriptor | — | **0 ms** |

Pinned by a new end-to-end scenario, `connect backoff caps a retry storm`.

### Plugin frame cache under real host traffic

During the same session Resolve issued roughly 25 consecutive renders for one
frame at **17-30 ms intervals**, all served from the plugin's single-frame cache
(`cacheHit=true`). Without it that burst would have been 25 renderer round trips
for one displayed image.

## Not run — what is still open in host

- Killing the service **while a request is genuinely in flight**. The kill here
  landed between renders, so the client discovered it on the next write rather
  than mid-transfer.
- Host-issued abort. Across every session Resolve has **never** set the abort
  flag on this node, including during active scrubbing. The synthetic abort test
  proves the client cancels promptly when told to; it does not prove Resolve ever
  tells it to. **The deadline, not cancellation, is what actually protects the
  render thread** — which matters for Phase 3, where slow renders are the norm.
- Resolve's concurrency pattern under load. Only one render thread has ever been
  observed per instance.
- Deliver renders. `interactive` was `false` on every call ever logged, so the
  interactive last-good path has never been taken.
- The hostile-payload matrix in host. Malformed responses were only exercised
  out of host.

## Decision

The bridge gate passes out of host, and its core in-host path passes as well: a
full working → service-killed → degraded → service-restarted → recovered cycle
completed inside Resolve with no crash, no hang, no corrupt frame and no host
restart.

Two defects were found and fixed **because** the work moved into the host: a
`noexcept` path that would have called `std::terminate()` inside Resolve, and a
per-frame 1 s stall whenever the service is down. Neither was visible from the
out-of-host suite alone.

The gate is not fully closed. The hostile-payload matrix has not been replayed in
host, a kill mid-transfer has not been staged, and Deliver has never been
exercised. T02 also remains largely unrun. Those are the conditions to clear
before Remotion enters the picture.

## Follow-up

- Run T01, then T02, then the in-host half of T03, in that order.
- Re-run this suite after any change to the parsing boundary; it is cheap and it
  is the regression net for the fixes above.
- When a real renderer replaces the fake one, re-measure. The cache-miss numbers
  here are a JavaScript fixture's generation cost and carry no information about
  Remotion's.
