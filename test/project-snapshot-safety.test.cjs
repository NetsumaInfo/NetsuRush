const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProjectSnapshot } = require('../core/projectSnapshot.js');

function readers(cutResult = { ok: true, timeline: 'T1', cuts: [] }) {
  return {
    listMediaPool: async () => ({ connected: true, project: 'AMV', clips: [] }),
    listTimelines: async () => ({ ok: true, timelines: [{ name: 'T1' }] }),
    timelineTree: async () => ({ ok: true, folders: [] }),
    timelineThumbs: async () => ({ ok: true, thumbs: [] }),
    readTimelineCutsByName: async () => cutResult,
  };
}

test('strict capture rejects an incomplete timeline cache', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-project-snapshot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const snapshot = createProjectSnapshot({ dataDir });

  const result = await snapshot.capture(readers({ ok: false, cuts: [] }), null, { requireComplete: true });

  assert.equal(result.ok, false);
  assert.match(result.error, /cache|cach|缓存|キャッシュ/i);
});

test('strict capture confirms complete data written to disk', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-project-snapshot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const snapshot = createProjectSnapshot({ dataDir });

  const result = await snapshot.capture(readers(), null, { requireComplete: true });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'project-snapshot.json')), true);
  assert.equal(snapshot.state().cuts, 1);
});

test('strict capture rejects a cache that cannot be persisted', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-project-snapshot-'));
  const snapshot = createProjectSnapshot({ dataDir });
  fs.rmSync(dataDir, { recursive: true, force: true });

  const result = await snapshot.capture(readers(), null, { requireComplete: true });

  assert.equal(result.ok, false);
});

test('incremental capture skips cached timelines and refreshes only the requested edit', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-project-snapshot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const snapshot = createProjectSnapshot({ dataDir });
  let cuts = [{ id: '1', path: 'C:\\rush.mkv', track: 1, tlStart: 0, inFrame: 0, outFrame: 23, fps: 24, srcFrames: 240 }];
  let reads = 0, mediaReads = 0, treeReads = 0;
  const dynamicReaders = () => ({
    ...readers(),
    listMediaPool: async () => { mediaReads++; return { connected: true, project: 'AMV', clips: [] }; },
    timelineTree: async () => { treeReads++; return { ok: true, folders: [] }; },
    timelineThumbs: async () => ({ ok: true, thumbs: [{ name: 'T1', path: cuts[0].path, in: cuts[0].inFrame / cuts[0].fps }] }),
    readTimelineCutsByName: async () => { reads++; return { ok: true, timeline: 'T1', cuts }; },
  });

  await snapshot.capture(dynamicReaders(), null, { skipExistingCuts: true, project: 'AMV', scanTimelineThumbs: false });
  const unchanged = await snapshot.capture(dynamicReaders(), null, { skipExistingCuts: true, project: 'AMV', scanTimelineThumbs: false });
  cuts = [{ ...cuts[0], outFrame: 47 }];
  const changed = await snapshot.capture(dynamicReaders(), null, { skipExistingCuts: true, project: 'AMV', refreshTimeline: 'T1', scanTimelineThumbs: false });

  assert.equal(reads, 2, 'cached timelines must not monopolize the Resolve bridge');
  assert.equal(mediaReads, 1, 'the persisted Media Pool must not be rescanned on every incremental build');
  assert.equal(treeReads, 1, 'an unchanged timeline list must reuse its persisted tree');
  assert.equal(unchanged.fresh, 0);
  assert.equal(changed.fresh, 1);
  assert.equal(snapshot.get().cuts.T1[0].outFrame, 47);
});

test('strict host-close capture revalidates cached timeline contents', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-project-snapshot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const snapshot = createProjectSnapshot({ dataDir });
  let cuts = [{ id: '1', path: 'C:\\rush.mkv', track: 1, tlStart: 0, inFrame: 0, outFrame: 23, fps: 24, srcFrames: 240 }];
  let reads = 0;
  const dynamicReaders = () => ({
    ...readers(),
    readTimelineCutsByName: async () => { reads++; return { ok: true, timeline: 'T1', cuts }; },
  });

  await snapshot.capture(dynamicReaders(), null, { requireComplete: true });
  cuts = [{ ...cuts[0], outFrame: 47 }];
  await snapshot.capture(dynamicReaders(), null, { skipExistingCuts: true, waitIfBusy: true, requireComplete: true });

  assert.equal(reads, 2, 'closing Resolve must verify edits even when a timeline is already cached');
  assert.equal(snapshot.get().cuts.T1[0].outFrame, 47);
});

test('capture removes timelines and derived cards that no longer exist', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-project-snapshot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const snapshot = createProjectSnapshot({ dataDir });
  await snapshot.capture(readers({ ok: true, timeline: 'T1', cuts: [{ id: '1', path: 'C:\\rush.mkv', in: 1 }] }));
  const emptyReaders = {
    ...readers(),
    listTimelines: async () => ({ ok: true, timelines: [] }),
    timelineThumbs: async () => ({ ok: true, thumbs: [] }),
  };

  await snapshot.capture(emptyReaders, null, { skipExistingCuts: true });

  assert.deepEqual(snapshot.get().cuts, {});
  assert.deepEqual(snapshot.get().thumbs, []);
});
