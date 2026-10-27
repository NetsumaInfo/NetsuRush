// matchTimelineRate: in a project that already holds a timeline, Resolve ignores the project-level
// rate, so a new timeline kept 23.976 and a 30 fps shot of 30 frames was conformed to 23 (measured on
// Resolve Studio 21.1.2). The timeline's own setting takes integer rates and 23.976 but refuses 29.97,
// 59.94 and 47.952 in every spelling; those go through an empty FCPXML sequence at the exact rate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { matchTimelineRate } = require('../core/timeline');

const ACCEPTED = new Set(['23.976', '24', '25', '30', '48', '50', '60']);

function fakeResolve(projectRate = 23.976) {
  const log = { imported: null, deleted: 0 };
  const timeline = (name, rate) => ({
    rate,
    async GetName() { return name; },
    async GetStartTimecode() { return '01:00:00:00'; },
    async GetSetting(key) { return key === 'timelineFrameRate' ? String(this.rate) : ''; },
    async SetSetting(key, value) {
      if (key !== 'timelineFrameRate') return true;
      if (!ACCEPTED.has(value)) return false;
      this.rate = Number(value);
      return true;
    },
  });
  const proj = { async GetSetting(key) { return key === 'timelineResolutionWidth' ? '3840' : key === 'timelineResolutionHeight' ? '2160' : ''; } };
  const mp = {
    async DeleteTimelines() { log.deleted++; return true; },
    async ImportTimelineFromFile(file, opts) {
      log.imported = fs.readFileSync(file, 'utf8');
      const m = /frameDuration="(\d+)\/(\d+)s"/.exec(log.imported);
      return timeline(opts.timelineName, Math.round((Number(m[2]) / Number(m[1])) * 1000) / 1000);
    },
    async CreateEmptyTimeline(name) { return timeline(name, projectRate); },
  };
  return { proj, mp, log, timeline };
}

test('a timeline already at the clip rate is kept as is', async () => {
  const { proj, mp, log, timeline } = fakeResolve();
  const tl = timeline('a', 23.976);
  const r = await matchTimelineRate(proj, mp, tl, 24000 / 1001);
  assert.equal(r.tl, tl);
  assert.equal(log.deleted, 0);
});

test('an integer rate is set on the timeline itself', async () => {
  const { proj, mp, log, timeline } = fakeResolve();
  const tl = timeline('obs', 23.976);
  const r = await matchTimelineRate(proj, mp, tl, 30);
  assert.equal(r.tl, tl);
  assert.equal(r.rate, 30);
  assert.equal(log.deleted, 0);
});

test('29.97 goes through an empty FCPXML at the exact rate, same name, size and start', async () => {
  const { proj, mp, log, timeline } = fakeResolve();
  const r = await matchTimelineRate(proj, mp, timeline('web', 23.976), 30000 / 1001);
  assert.equal(log.deleted, 1);
  assert.match(log.imported, /frameDuration="1001\/30000s"/);
  assert.match(log.imported, /width="3840" height="2160"/);
  assert.match(log.imported, new RegExp(`tcStart="${108000 * 1001}/30000s"`), '01:00:00:00 kept');
  assert.equal(await r.tl.GetName(), 'web');
  assert.equal(r.rate, 29.97);
});

test('59.94 too', async () => {
  const { proj, mp, log, timeline } = fakeResolve();
  const r = await matchTimelineRate(proj, mp, timeline('game', 23.976), 60000 / 1001);
  assert.match(log.imported, /frameDuration="1001\/60000s"/);
  assert.equal(r.rate, 59.94);
});
