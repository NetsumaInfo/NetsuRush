const test = require('node:test');
const assert = require('node:assert/strict');

const { assessTransfer } = require('../core/transfer/equivalence');
const { capabilitiesFor, RESOLVE_FUSION_RUNTIME } = require('../core/transfer/capabilities');

function doc(clip) {
  return {
    ok: true, version: 2, host: 'resolve', timeline: 'T', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 100, missing: [], clips: [clip],
  };
}

function clip(over = {}) {
  return {
    kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 100,
    srcIn: 0, srcOut: 99, tlStart: 0, tlEnd: 100, ...over,
  };
}

test('Premiere promet transformations et animations intrinsèques, pas le retime écrit', () => {
  const input = doc(clip({
    video: { transform: {
      position: { value: { x: 10, y: 20 }, keyframes: [
        { frame: 0, value: { x: 10, y: 20 } }, { frame: 50, value: { x: 100, y: 20 } },
      ] },
      scale: { value: { x: 1.5, y: 1.5 } }, opacity: { value: 50 },
    } },
    timing: { speed: { numerator: 2, denominator: 1 }, reverse: false, freeze: false },
  }));
  const assessment = assessTransfer(input, 'ppro');
  assert.equal(assessment.items.some((i) => i.property === 'video.position.keyframes' && i.status === 'expected'), true);
  assert.equal(assessment.items.some((i) => i.property === 'timing.speed' && i.status === 'unsupported'), true);
  assert.equal(assessment.faithful, false);
});

test('After Effects couvre transform, retime et niveau audio, mais pas le panoramique', () => {
  const input = doc(clip({
    audio: { gainDb: { value: -6 }, pan: { value: 0.5 } },
    timing: { speed: { numerator: 1, denominator: 2 }, reverse: true, freeze: false },
  }));
  const assessment = assessTransfer(input, 'aeft');
  assert.equal(assessment.items.some((i) => i.property === 'timing.speed' && i.status === 'expected'), true);
  // Le niveau d'un calque AE est en dB, comme le document ; le panoramique de calque n'existe pas.
  assert.equal(assessment.items.some((i) => i.property === 'audio.gain' && i.status === 'expected'), true);
  assert.equal(assessment.items.some((i) => i.property === 'audio.pan' && i.status === 'unsupported'), true);
});

test('Resolve n’annonce les images clés QUE si la comp Fusion est de la partie', () => {
  const animated = doc(clip({ video: { transform: { position: {
    value: { x: 0, y: 0 },
    keyframes: [{ frame: 0, value: { x: 0, y: 0 } }, { frame: 50, value: { x: 200, y: 0 } }],
  } } } }));
  const bare = assessTransfer(animated, 'resolve');
  assert.equal(bare.items.find((i) => i.property === 'video.position.keyframes').status, 'unsupported');
  const fusion = assessTransfer(animated, 'resolve', { runtime: RESOLVE_FUSION_RUNTIME });
  assert.equal(fusion.items.find((i) => i.property === 'video.position.keyframes').status, 'expected');
});

test('un sondage runtime peut retirer une capacité Premiere absente', () => {
  const caps = capabilitiesFor('ppro', { 'video.scale': 'unsupported' });
  assert.equal(caps['video.scale'], 'unsupported');
  const assessment = assessTransfer(doc(clip({
    video: { transform: { scale: { value: { x: 2, y: 2 } } } },
  })), 'ppro', { runtime: { 'video.scale': 'unsupported' } });
  assert.equal(assessment.items.find((i) => i.property === 'video.scale').status, 'unsupported');
});

test('textes, transitions et effets particuliers sont différés explicitement', () => {
  const assessment = assessTransfer(doc(clip({ deferred: ['text', 'transition', 'effect'] })), 'resolve');
  assert.equal(assessment.deferred, 3);
  assert.deepEqual(
    assessment.items.filter((i) => i.status === 'deferred').map((i) => i.property),
    ['text', 'transition', 'effect'],
  );
});
