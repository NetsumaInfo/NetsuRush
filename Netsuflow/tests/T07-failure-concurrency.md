# T07: Failure, concurrency, and soak

## Question

Can Resolve and NetsuRush remain stable under realistic and adversarial lifecycle conditions?

## Scenarios

- Resolve issues concurrent frames from one and multiple instances.
- Interactive scrub overlaps final render.
- Service exits, hangs, restarts, or changes protocol version.
- Selected engine worker/browser crashes or exceeds memory budget.
- Project is removed, renamed, or edited mid-render.
- Disk fills or cache permissions fail.
- NetsuRush exits while Resolve remains open and vice versa.
- System sleeps/resumes.
- One engine is unavailable while another binding remains valid.
- 10,000 randomized requests and a long final render.

## Instrumentation

Capture per-request phase timings, queue depth, cancellations, cache state, worker/browser restarts, process memory, handles/file descriptors, and Resolve responsiveness.

## Pass

- No crash, deadlock, unbounded wait, handle leak, or unbounded memory.
- Final-render errors are explicit and never silently return stale frames.
- Interactive obsolete work is cancelled or deprioritized.
- Service restart is recoverable without restarting Resolve.
- Thread-safety declaration matches observed implementation behavior. [S-OFX-THREADING]

## Stop

Any reproducible host crash from a bounded protocol input blocks packaging work.
