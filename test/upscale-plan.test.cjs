// A network ALWAYS outputs `native × input`, so sizing an upscale means choosing the INPUT. These
// tests hold the three rules: the input is the source capped at the 1080p box and never reduced
// below it, it is enlarged BEFORE the network when that one cannot reach the output, and the
// network never has its result enlarged AFTER it. The table is shared with the Python twin
// (test/test_upscale_plan.py), so the two implementations cannot drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');

const { upscalePlan, outputSize, fitBox, FEED_CAP } = require('../core/upscaleArgs');
const { cases } = require('./fixtures/upscale-plan.json');

const size = ([width, height]) => ({ width, height });

test('missing source dimensions: no plan', () => {
  assert.equal(upscalePlan({ srcWidth: 0, srcHeight: 1080, target: 2160, native: 2 }), null);
});

for (const c of cases) {
  test(`table: ${c.name}`, () => {
    const p = upscalePlan({ srcWidth: c.src[0], srcHeight: c.src[1], target: c.target, scale: c.scale, native: c.native });
    assert.deepEqual(p, { feed: size(c.feed), out: size(c.out), resample: c.resample });
  });
}

test('a resolution class is a 16:9 box oriented like the image', () => {
  assert.deepEqual(fitBox(1920, 800, 1080), { width: 1920, height: 800 });
  assert.deepEqual(fitBox(1920, 886, 2160), { width: 3840, height: 1772 });
  assert.deepEqual(fitBox(1080, 1920, 2160), { width: 2160, height: 3840 });
  assert.deepEqual(fitBox(1440, 1080, 2160), { width: 2880, height: 2160 });
});

test('free-size engines get the class, or the factor without one', () => {
  assert.deepEqual(outputSize({ width: 1920, height: 886 }, 2, 2160), { width: 3840, height: 1772 });
  assert.deepEqual(outputSize({ width: 1280, height: 720 }, 2, 0), { width: 2560, height: 1440 });
  assert.deepEqual(outputSize({ width: 1280, height: 720 }, 4), { width: 5120, height: 2880 });
});

test('no plan reduces below the 1080p box or enlarges after the network', () => {
  const sources = [[640, 480], [854, 480], [1280, 720], [1280, 534], [1920, 1080], [1920, 800],
    [1080, 1920], [1440, 1080], [2560, 1440], [2560, 1066], [3840, 2160], [3840, 1600], [4096, 1716]];
  for (const [w, h] of sources) {
    const capped = fitBox(w, h, FEED_CAP);
    const floor = { width: Math.min(w, capped.width), height: Math.min(h, capped.height) };
    for (const native of [1, 2, 4]) {
      for (const [target, scale] of [[1080, 2], [1440, 2], [2160, 2], [0, 1], [0, 2], [0, 4]]) {
        const p = upscalePlan({ srcWidth: w, srcHeight: h, target, scale, native });
        const label = `${w}x${h} -> ${target || `x${scale}`} with x${native}`;
        assert.ok(native * p.feed.width >= p.out.width && native * p.feed.height >= p.out.height,
          `${label}: the network falls short of the output`);
        // `fitBox` rounds to even; the floor check allows that one pixel.
        assert.ok(p.feed.width >= floor.width - 1 && p.feed.height >= floor.height - 1,
          `${label}: fed ${p.feed.width}x${p.feed.height}, below ${floor.width}x${floor.height}`);
        assert.equal(p.out.width % 2, 0, `${label}: odd width`);
        assert.equal(p.out.height % 2, 0, `${label}: odd height`);
      }
    }
  }
});
