// Who renders what, in which order, and what is allowed to be remembered.
//
// The measurements this is built from, rather than guessed at:
//
//   - T01: Resolve issued **21 render calls for one frame**, some 23 ms apart.
//     Without in-flight deduplication that is 21 browser captures for one
//     picture, and at the H02 rate of ~117 ms each it is 2.4 s of work for
//     117 ms of result.
//   - T01: Resolve **never aborts** a render on this node. So a request that
//     nobody wants any more still has a caller blocked on it, and dropping it
//     is not an option — cancellation only ever comes from our own deadline.
//   - H02: one 1080p frame is 8.3 MiB decoded. A cache counted in entries
//     rather than bytes is a cache with no bound at all, because the entry size
//     is set by whatever resolution the host asked for.
//
// Everything here is pure: it schedules and remembers, and calls a `render`
// function it is given. That keeps it testable without a browser, and keeps the
// engine out of a module that has nothing to do with any particular engine.

export class SchedulerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    this.details = details;
  }
}

/// Requested work always outranks prefetch, and interactive work is answered
/// before final work — a scrubbing user is waiting on the first, a render is
/// waiting on the second and does not care about 200 ms.
export const PRIORITIES = Object.freeze(['interactive', 'final', 'prefetch']);

const PRIORITY_RANK = new Map(PRIORITIES.map((name, index) => [name, index]));

/// Bounded by bytes, not entries.
class DecodedFrameCache {
  #maxBytes;
  #entries = new Map();
  #bytes = 0;

  constructor(maxBytes) {
    this.#maxBytes = maxBytes;
  }

  get bytes() {
    return this.#bytes;
  }

  get size() {
    return this.#entries.size;
  }

  /// LRU: reading moves an entry to the end of the insertion order, which is
  /// what a Map iterates in.
  get(key) {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key, entry, byteLength) {
    if (byteLength > this.#maxBytes) {
      // A single frame larger than the whole budget is not an eviction problem,
      // it is a frame that must not be cached at all. Caching it would evict
      // everything else and then evict itself on the next insert.
      return false;
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#bytes -= existing.byteLength;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { ...entry, byteLength });
    this.#bytes += byteLength;
    this.#evict();
    return true;
  }

  /// Drops every entry whose revision matches, whatever its frame or size.
  deleteRevision(revision) {
    let dropped = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.revision !== revision) continue;
      this.#bytes -= entry.byteLength;
      this.#entries.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #evict() {
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      const entry = this.#entries.get(oldest.value);
      this.#bytes -= entry.byteLength;
      this.#entries.delete(oldest.value);
    }
  }
}

/**
 * Creates a frame scheduler.
 *
 * @param {object} options
 * @param {(job:{descriptor:object, key:string, revision:string, signal:AbortSignal}) => Promise<{pixels:Buffer}>} options.render
 * @param {number} [options.concurrency]   simultaneous renders; 1 for a single browser page
 * @param {number} [options.maxQueued]     bound on waiting work, excluding prefetch
 * @param {number} [options.maxPrefetch]   bound on waiting prefetch
 * @param {number} [options.cacheBytes]    decoded memory budget
 */
export function createFrameScheduler({
  render,
  concurrency = 1,
  maxQueued = 64,
  maxPrefetch = 16,
  cacheBytes = 256 * 1024 * 1024,
} = {}) {
  if (typeof render !== 'function') throw new TypeError('render(job) is required');

  const cache = new DecodedFrameCache(cacheBytes);
  /// key -> { promise, waiters, priority, controller, revision }
  const inFlight = new Map();
  const queue = [];
  let running = 0;
  let sequence = 0;
  let closed = false;

  const stats = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    dedupedRequests: 0,
    renders: 0,
    rejectedQueueFull: 0,
    prefetchDropped: 0,
    invalidations: 0,
    promotions: 0,
  };

  function queuedCount(priority) {
    return queue.reduce(
      (total, job) => total + (priority === 'prefetch' ? job.priority === 'prefetch' : job.priority !== 'prefetch'),
      0,
    );
  }

  /// Highest priority first, then oldest first inside a priority.
  ///
  /// Stable by construction rather than by relying on sort stability: the
  /// sequence number is the tiebreak, so a prefetch queued long ago never
  /// overtakes an interactive request queued a moment ago.
  function nextJobIndex() {
    let best = -1;
    for (let i = 0; i < queue.length; i += 1) {
      if (best === -1) {
        best = i;
        continue;
      }
      const a = queue[i];
      const b = queue[best];
      const rankA = PRIORITY_RANK.get(a.priority);
      const rankB = PRIORITY_RANK.get(b.priority);
      if (rankA < rankB || (rankA === rankB && a.sequence < b.sequence)) best = i;
    }
    return best;
  }

  function pump() {
    while (running < concurrency && queue.length > 0) {
      const index = nextJobIndex();
      const job = queue.splice(index, 1)[0];
      running += 1;
      stats.renders += 1;

      render({
        descriptor: job.descriptor, key: job.key, revision: job.revision,
        signal: job.controller.signal,
      })
        .then(
          (frame) => {
            const byteLength = frame?.pixels?.byteLength ?? 0;
            // Not cached if the revision went away while this was rendering:
            // the key nobody will ask for again is memory nobody will reclaim
            // until eviction gets to it.
            if (byteLength > 0 && !job.controller.signal.aborted) {
              cache.set(job.key, { frame, revision: job.revision }, byteLength);
            }
            job.resolve(frame);
          },
          (error) => job.reject(error),
        )
        .finally(() => {
          running -= 1;
          inFlight.delete(job.key);
          pump();
        });
    }
  }

  return {
    stats,
    get cacheBytes() {
      return cache.bytes;
    },
    get cacheEntries() {
      return cache.size;
    },
    get inFlightCount() {
      return inFlight.size;
    },
    get queuedCount() {
      return queue.length;
    },

    /**
     * Requests one frame.
     *
     * @param {object} request
     * @param {object} request.descriptor  passed through to render()
     * @param {string} request.key         canonical frame key
     * @param {string} request.revision    canonical revision key, for invalidation
     * @param {'interactive'|'final'|'prefetch'} [request.priority]
     */
    async request({ descriptor, key, revision, priority = 'interactive' }) {
      if (closed) throw new SchedulerError('SCHEDULER_CLOSED', 'the scheduler is closed');
      if (typeof key !== 'string' || key === '') {
        throw new SchedulerError('CACHE_KEY_INVALID', 'a canonical frame key is required');
      }
      if (typeof revision !== 'string' || revision === '') {
        throw new SchedulerError('CACHE_KEY_INVALID', 'a canonical revision key is required');
      }
      if (!PRIORITY_RANK.has(priority)) {
        throw new SchedulerError('SCHEDULER_INVALID', `priority must be one of ${PRIORITIES.join(', ')}`);
      }
      stats.requests += 1;

      const cached = cache.get(key);
      if (cached !== undefined) {
        stats.cacheHits += 1;
        return cached.frame;
      }
      stats.cacheMisses += 1;

      const existing = inFlight.get(key);
      if (existing !== undefined) {
        // The T01 case: Resolve asking for one frame 21 times. Every repeat
        // joins the render already running instead of starting another.
        stats.dedupedRequests += 1;
        // A real request arriving for something currently queued as prefetch
        // must stop being prefetch, or the caller waits behind work that was
        // only ever speculative.
        if (PRIORITY_RANK.get(priority) < PRIORITY_RANK.get(existing.priority)) {
          existing.priority = priority;
          const queued = queue.find((job) => job.key === key);
          if (queued) {
            queued.priority = priority;
            stats.promotions += 1;
          }
        }
        return existing.promise;
      }

      const isPrefetch = priority === 'prefetch';
      const limit = isPrefetch ? maxPrefetch : maxQueued;
      if (queuedCount(isPrefetch ? 'prefetch' : 'requested') >= limit) {
        if (isPrefetch) {
          // Speculative work is the only work allowed to disappear. A requested
          // frame has a host render thread blocked on it, and T01 measured that
          // Resolve never aborts, so refusing it is the honest answer.
          stats.prefetchDropped += 1;
          throw new SchedulerError('SCHEDULER_PREFETCH_DROPPED', 'the prefetch queue is full', {
            retryable: false,
          });
        }
        stats.rejectedQueueFull += 1;
        throw new SchedulerError('SCHEDULER_BUSY', `more than ${limit} frames are already waiting`, {
          retryable: true,
        });
      }

      const controller = new AbortController();
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });

      const job = {
        descriptor,
        key,
        revision,
        priority,
        controller,
        sequence: (sequence += 1),
        resolve,
        reject,
      };
      // The job goes into the in-flight index, not just its promise: close()
      // has to be able to settle work that has already left the queue and is
      // running, or the caller waits on a promise that never resolves.
      inFlight.set(key, { promise, priority, controller, revision, job });
      queue.push(job);
      pump();
      return promise;
    },

    /**
     * Drops every cached frame of a revision, and abandons in-flight work for
     * it: those pixels are already known to be stale.
     *
     * Callers still waiting are rejected rather than served the old frame. A
     * stale frame delivered quietly is worse than an error, because nothing
     * downstream can tell it apart from a correct one.
     */
    invalidate(revision) {
      stats.invalidations += 1;
      const dropped = cache.deleteRevision(revision);
      let aborted = 0;
      for (const [key, entry] of inFlight) {
        if (entry.revision !== revision) continue;
        entry.controller.abort();
        aborted += 1;
        const index = queue.findIndex((job) => job.key === key);
        if (index >= 0) {
          const [job] = queue.splice(index, 1);
          inFlight.delete(key);
          job.reject(
            new SchedulerError('CACHE_INVALIDATED', 'the binding revision changed while this frame was queued', {
              retryable: true,
            }),
          );
        }
      }
      return { dropped, aborted };
    },

    /// Rejects everything outstanding and forgets everything cached.
    ///
    /// Queued *and* running work, both. The engine cannot cancel a capture in
    /// flight, so the render itself keeps going and its result is discarded —
    /// but the caller is told now instead of waiting on a promise that will
    /// never settle, which is the failure mode that hides until a shutdown
    /// happens to land mid-render.
    async close() {
      closed = true;
      for (const job of queue.splice(0)) {
        job.controller.abort();
        inFlight.delete(job.key);
        job.reject(new SchedulerError('SCHEDULER_CLOSED', 'the scheduler closed while this frame was queued'));
      }
      for (const entry of inFlight.values()) {
        entry.controller.abort();
        entry.job.reject(
          new SchedulerError('SCHEDULER_CLOSED', 'the scheduler closed while this frame was rendering'),
        );
      }
      inFlight.clear();
      cache.clear();
    },
  };
}
