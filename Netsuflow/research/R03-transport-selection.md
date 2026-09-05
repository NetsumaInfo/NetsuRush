# R03: Pixel transport selection

## Hypothesis

Rendering is likely to dominate uncached latency, while PNG decode or socket copies may dominate cache hits. The transport must therefore be selected using split timings.

## Candidates

- Atomic PNG file: strongest baseline and easiest inspection.
- Raw RGBA over framed loopback TCP: simplest low-decode cross-platform path. [S-NODE-NET]
- Windows named pipe / macOS Unix-domain socket: possible local control alternative. [S-WIN-NAMED-PIPES]
- Memory-mapped buffers: lower copying potential with significantly harder ownership, synchronization, and crash cleanup. [S-WIN-FILE-MAPPING]

## Benchmark matrix

- 1920x1080 and 3840x2160;
- opaque and alpha-heavy fixtures;
- sequential, reverse, random, and repeated requests;
- cold disk, warm OS cache, service memory hit;
- byte RGBA first;
- 100 warm-up and at least 1,000 measured cache-hit samples.

Record encode, write, read, decode, socket, validation, conversion, and OFX copy separately.

## First measurement

Framed RGBA over loopback TCP was implemented first and measured in T03 on an AMD Ryzen 7 6800H, against a fake service holding a bounded frame cache:

| Path | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| Cache hit, 1080p RGBA8 | 2,000 | 4.57 ms | 6.92 ms | 26.33 ms |
| Service regenerates each frame, 1080p | 10,000 | 11.08 ms | 21.13 ms | 31.69 ms |

The cache-hit p95 clears the 20 ms target with about 3x headroom, so **the simplest cross-platform transport already meets the bar** and neither shared memory nor a named pipe is justified by evidence today. The split above also shows why the hypothesis at the top of this note was right to insist on split timings: an early run that conflated generation with transport looked like a miss.

Caveats on these numbers: the service is single-threaded JavaScript on the same machine, PNG was never involved (raw RGBA only), and the p99 tail comes from Node's event loop rather than from the client.

## Decision

Choose the least complex option meeting the cache-hit target. Shared memory is not selected merely because it appears architecturally faster. On current evidence loopback TCP stays. HyperFrames H02/H03 must add PNG capture/decode timings; only a measured transport or decode bottleneck can reopen this decision. The same conclusion will later be rechecked with Remotion without changing the protocol abstraction.
