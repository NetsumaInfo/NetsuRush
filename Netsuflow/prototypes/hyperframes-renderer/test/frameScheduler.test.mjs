// The scheduler's promises, as tests.
//
// Two of these come straight from measurements. Resolve issued 21 render calls
// for one frame (T01), so deduplication is not an optimization but the
// difference between 117 ms and 2.4 s of work. And Resolve never aborts a
// render (T01), so a queue that drops requested work strands a host thread —
// only prefetch may disappear.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PRIORITIES, SchedulerError, createFrameScheduler } from '../frameScheduler.mjs';

/// A render function whose completion is controlled by the test, so ordering
/// and concurrency are observable instead of raced.
function controllableRender({ bytes = 1024 } = {}) {
  const pending = [];
  const started = [];
  const render = ({ descriptor, key, signal }) => {
    started.push(descriptor?.label ?? key);
    return new Promise((resolve, reject) => {
      pending.push({
        key,
        descriptor,
        signal,
        finish: (frame) => resolve(frame ?? { pixels: Buffer.alloc(bytes), key }),
        fail: (error) => reject(error),
      });
    });
  };
  return {
    render,
    started,
    pending,
    finishAll() {
      for (const job of pending.splice(0)) job.finish();
    },
    finishFirst() {
      const job = pending.shift();
      job.finish();
      return job;
    },
  };
}

/// Lets the microtask queue drain so scheduling decisions have happened.
const settle = () => new Promise((resolve) => setImmediate(resolve));

/// Claims a request's outcome without asserting on it yet.
///
/// Every promise the scheduler hands back has to be claimed the moment it is
/// created. `close()` rejects outstanding work inside its own tick, so a handler
/// attached afterwards is attached too late and Node reports an unhandled
/// rejection — which is the right complaint: an unclaimed promise here is a
/// caller left waiting forever in production.
const outcome = (promise) => promise.then((frame) => ({ frame }), (error) => ({ error }));

/// Completes renders one at a time until nothing is left running.
///
/// One at a time on purpose: with concurrency 1 each completion is what lets
/// the next job start, so this is also what makes the selection order visible.
async function drain(harness) {
  while (harness.pending.length > 0) {
    harness.finishFirst();
    await settle();
  }
}

test('identical in-flight requests are deduplicated into one render', async () => {
  // The T01 case, exactly: 21 requests for one frame.
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render });

  const waiters = [];
  for (let i = 0; i < 21; i += 1) {
    waiters.push(scheduler.request({ descriptor: { frame: 7 }, key: 'k7', revision: 'r1' }));
  }
  await settle();

  assert.equal(harness.started.length, 1, 'one render for 21 requests');
  assert.equal(scheduler.stats.dedupedRequests, 20);

  harness.finishAll();
  const frames = await Promise.all(waiters);
  assert.equal(frames.length, 21);
  // Every caller gets the same object, not 21 decodes of the same picture.
  for (const frame of frames) assert.equal(frame, frames[0]);
  await scheduler.close();
});

test('a repeated request after completion is a cache hit, not a render', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render });

  const first = scheduler.request({ descriptor: {}, key: 'k1', revision: 'r1' });
  await settle();
  harness.finishAll();
  await first;

  await scheduler.request({ descriptor: {}, key: 'k1', revision: 'r1' });
  assert.equal(scheduler.stats.renders, 1);
  assert.equal(scheduler.stats.cacheHits, 1);
  await scheduler.close();
});

test('requested work outranks prefetch, and interactive outranks final', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  // One render occupies the single slot; the rest queue behind it.
  const blocker = scheduler.request({ descriptor: { label: 'blocker' }, key: 'block', revision: 'r1' });
  await settle();

  const others = [
    outcome(scheduler.request({ descriptor: { label: 'prefetch' }, key: 'p', revision: 'r1', priority: 'prefetch' })),
    outcome(scheduler.request({ descriptor: { label: 'final' }, key: 'f', revision: 'r1', priority: 'final' })),
    outcome(scheduler.request({ descriptor: { label: 'interactive' }, key: 'i', revision: 'r1', priority: 'interactive' })),
  ];
  await settle();

  assert.deepEqual(harness.started, ['blocker'], 'nothing else runs while the slot is busy');

  // Release one slot at a time and watch the order they are chosen in.
  await drain(harness);

  await blocker;
  await Promise.all(others);
  assert.deepEqual(harness.started, ['blocker', 'interactive', 'final', 'prefetch']);
  await scheduler.close();
});

test('among equal priorities the oldest request runs first', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  const all = [outcome(scheduler.request({ descriptor: { label: 'a' }, key: 'a', revision: 'r1' }))];
  await settle();
  for (const label of ['b', 'c', 'd']) {
    all.push(outcome(scheduler.request({ descriptor: { label }, key: label, revision: 'r1' })));
  }
  await settle();

  await drain(harness);
  await Promise.all(all);
  assert.deepEqual(harness.started, ['a', 'b', 'c', 'd']);
  await scheduler.close();
});

test('a real request promotes work that was only queued as prefetch', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  const blocker = scheduler.request({ descriptor: { label: 'blocker' }, key: 'block', revision: 'r1' });
  await settle();

  const speculative = outcome(
    scheduler.request({ descriptor: { label: 'speculative' }, key: 'x', revision: 'r1', priority: 'prefetch' }),
  );
  const other = outcome(scheduler.request({ descriptor: { label: 'other' }, key: 'y', revision: 'r1', priority: 'final' }));
  await settle();

  // The user scrubbed onto the frame we were speculating about. It must stop
  // being speculative, or they wait behind work nobody asked for.
  const promoted = scheduler.request({ descriptor: { label: 'speculative' }, key: 'x', revision: 'r1' });
  await settle();
  assert.equal(scheduler.stats.promotions, 1);

  await drain(harness);

  await Promise.all([blocker, promoted, speculative, other]);
  assert.deepEqual(harness.started, ['blocker', 'speculative', 'other']);
  await scheduler.close();
});

test('a full prefetch queue drops prefetch; a full request queue refuses, retryably', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({
    render: harness.render,
    concurrency: 1,
    maxQueued: 2,
    maxPrefetch: 1,
  });

  const blocker = scheduler.request({ descriptor: {}, key: 'block', revision: 'r1' });
  await settle();

  const queued = [
    outcome(scheduler.request({ descriptor: {}, key: 'q1', revision: 'r1' })),
    outcome(scheduler.request({ descriptor: {}, key: 'q2', revision: 'r1' })),
  ];
  await settle();

  await assert.rejects(
    () => scheduler.request({ descriptor: {}, key: 'q3', revision: 'r1' }),
    (error) => error instanceof SchedulerError && error.code === 'SCHEDULER_BUSY' && error.details.retryable === true,
  );

  queued.push(outcome(scheduler.request({ descriptor: {}, key: 'pf1', revision: 'r1', priority: 'prefetch' })));
  await settle();
  await assert.rejects(
    () => scheduler.request({ descriptor: {}, key: 'pf2', revision: 'r1', priority: 'prefetch' }),
    (error) => error instanceof SchedulerError && error.code === 'SCHEDULER_PREFETCH_DROPPED',
  );

  harness.finishAll();
  await blocker;
  await scheduler.close();
  // Everything still queued when the scheduler closed must have been rejected
  // with a named code. A caller left waiting on a promise that never settles is
  // the failure this asserts against.
  for (const { error } of await Promise.all(queued)) {
    assert.ok(error instanceof SchedulerError, 'queued work must be rejected, not left pending');
    assert.equal(error.code, 'SCHEDULER_CLOSED');
  }
});

test('the cache is bounded by bytes, not entries', async () => {
  // One 1080p frame is 8.3 MiB. A cache counted in entries has no bound at all,
  // because the entry size is whatever resolution the host asked for.
  const big = 4 * 1024 * 1024;
  const harness = controllableRender({ bytes: big });
  const scheduler = createFrameScheduler({ render: harness.render, cacheBytes: 10 * 1024 * 1024 });

  for (const key of ['a', 'b', 'c']) {
    const pending = scheduler.request({ descriptor: {}, key, revision: 'r1' });
    await settle();
    harness.finishAll();
    await pending;
  }

  assert.equal(scheduler.cacheEntries, 2, 'only what fits in 10 MiB');
  assert.ok(scheduler.cacheBytes <= 10 * 1024 * 1024);

  // 'a' was the least recently used and is gone; 'c' is still there.
  await scheduler.request({ descriptor: {}, key: 'c', revision: 'r1' });
  assert.equal(scheduler.stats.cacheHits, 1);
  assert.equal(scheduler.stats.renders, 3);
  await scheduler.close();
});

test('a frame larger than the whole budget is not cached at all', async () => {
  // Caching it would evict everything else and then evict itself on the next
  // insert, which is worse than not caching it.
  const harness = controllableRender({ bytes: 8 * 1024 * 1024 });
  const scheduler = createFrameScheduler({ render: harness.render, cacheBytes: 1024 * 1024 });

  const pending = scheduler.request({ descriptor: {}, key: 'huge', revision: 'r1' });
  await settle();
  harness.finishAll();
  await pending;

  assert.equal(scheduler.cacheEntries, 0);
  assert.equal(scheduler.cacheBytes, 0);
  await scheduler.close();
});

test('invalidating a revision drops every frame of it, at every size', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render });

  for (const key of ['r1-f1', 'r1-f2-4k', 'r2-f1']) {
    const revision = key.startsWith('r1') ? 'rev-1' : 'rev-2';
    const pending = scheduler.request({ descriptor: {}, key, revision });
    await settle();
    harness.finishAll();
    await pending;
  }
  assert.equal(scheduler.cacheEntries, 3);

  const { dropped } = scheduler.invalidate('rev-1');
  assert.equal(dropped, 2);
  assert.equal(scheduler.cacheEntries, 1);

  // The other revision survives: invalidation is scoped, not a flush.
  await scheduler.request({ descriptor: {}, key: 'r2-f1', revision: 'rev-2' });
  assert.equal(scheduler.stats.cacheHits, 1);
  await scheduler.close();
});

test('a source change cannot return the frame from before it', async () => {
  // The failure this whole module exists to prevent: same frame number, same
  // size, different source, old pixels.
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render });

  const first = scheduler.request({ descriptor: { label: 'rev-1' }, key: 'key-rev-1', revision: 'rev-1' });
  await settle();
  harness.pending[0].finish({ pixels: Buffer.from('old-pixels') });
  harness.pending.shift();
  const oldFrame = await first;
  assert.equal(oldFrame.pixels.toString(), 'old-pixels');

  scheduler.invalidate('rev-1');

  // A different revision is a different key, so this cannot hit the old entry
  // even if invalidation had failed.
  const second = scheduler.request({ descriptor: { label: 'rev-2' }, key: 'key-rev-2', revision: 'rev-2' });
  await settle();
  harness.pending[0].finish({ pixels: Buffer.from('new-pixels') });
  const newFrame = await second;
  assert.equal(newFrame.pixels.toString(), 'new-pixels');
  assert.equal(scheduler.stats.renders, 2);
  await scheduler.close();
});

test('invalidation rejects queued waiters instead of serving them stale pixels', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  const blocker = scheduler.request({ descriptor: {}, key: 'block', revision: 'other' });
  await settle();
  const doomed = scheduler.request({ descriptor: {}, key: 'stale', revision: 'rev-1' });
  await settle();

  const { aborted } = scheduler.invalidate('rev-1');
  assert.equal(aborted, 1);
  await assert.rejects(
    () => doomed,
    (error) => error instanceof SchedulerError && error.code === 'CACHE_INVALIDATED' && error.details.retryable === true,
  );

  harness.finishAll();
  await blocker;
  await scheduler.close();
});

test('an in-flight render is told its revision went away', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  const pending = scheduler.request({ descriptor: {}, key: 'running', revision: 'rev-1' });
  await settle();
  const job = harness.pending[0];
  assert.equal(job.signal.aborted, false);

  scheduler.invalidate('rev-1');
  // The engine has no cancellation for a capture in flight, so the signal is
  // advisory — but it must be raised, or a render that can check has no way to
  // know its result is already unwanted.
  assert.equal(job.signal.aborted, true);

  job.finish();
  await pending;
  await scheduler.close();
});

test('a failed render is not cached and does not wedge the queue', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  const failing = scheduler.request({ descriptor: {}, key: 'bad', revision: 'r1' });
  await settle();
  harness.pending.shift().fail(new Error('capture failed'));
  await assert.rejects(() => failing, /capture failed/);

  assert.equal(scheduler.cacheEntries, 0);
  assert.equal(scheduler.inFlightCount, 0);

  // The slot is free and a retry starts a real render rather than joining a
  // dead one.
  const retry = scheduler.request({ descriptor: {}, key: 'bad', revision: 'r1' });
  await settle();
  assert.equal(harness.pending.length, 1);
  harness.finishAll();
  await retry;
  await scheduler.close();
});

test('close rejects outstanding work and refuses new work', async () => {
  const harness = controllableRender();
  const scheduler = createFrameScheduler({ render: harness.render, concurrency: 1 });

  const running = outcome(scheduler.request({ descriptor: {}, key: 'block', revision: 'r1' }));
  await settle();
  const queued = outcome(scheduler.request({ descriptor: {}, key: 'queued', revision: 'r1' }));
  await settle();

  await scheduler.close();

  // Both the queued job and the one already rendering are settled, with codes
  // that say which it was. Leaving the running one pending is the bug this
  // asserts against: it only ever appears when a shutdown lands mid-render.
  assert.equal((await queued).error?.code, 'SCHEDULER_CLOSED');
  assert.match((await queued).error.message, /queued/);
  assert.equal((await running).error?.code, 'SCHEDULER_CLOSED');
  assert.match((await running).error.message, /rendering/);

  await assert.rejects(
    () => scheduler.request({ descriptor: {}, key: 'later', revision: 'r1' }),
    (error) => error instanceof SchedulerError && error.code === 'SCHEDULER_CLOSED',
  );

  harness.finishAll();
});

test('bad arguments are refused rather than hashed into the cache', async () => {
  const scheduler = createFrameScheduler({ render: async () => ({ pixels: Buffer.alloc(8) }) });
  for (const bad of [undefined, '', 42]) {
    await assert.rejects(
      () => scheduler.request({ descriptor: {}, key: bad, revision: 'r1' }),
      (error) => error.code === 'CACHE_KEY_INVALID',
    );
    await assert.rejects(
      () => scheduler.request({ descriptor: {}, key: 'k', revision: bad }),
      (error) => error.code === 'CACHE_KEY_INVALID',
    );
  }
  await assert.rejects(
    () => scheduler.request({ descriptor: {}, key: 'k', revision: 'r1', priority: 'urgent' }),
    (error) => error.code === 'SCHEDULER_INVALID',
  );
  assert.deepEqual([...PRIORITIES], ['interactive', 'final', 'prefetch']);
  await scheduler.close();
});
