const test = require('node:test');
const assert = require('node:assert/strict');

const { transferReport, countValue } = require('../core/transfer/lossReport');

const assessment = {
  target: 'ppro', total: 2, exact: 2, approximated: 0, baked: 0,
  unsupported: 0, deferred: 0, bakeAvailable: 0, faithful: true,
  items: [
    { clip: 0, property: 'clip.media', status: 'expected' },
    { clip: 0, property: 'video.scale', status: 'expected' },
  ],
};

test('un résultat n’est vérifié que si chaque propriété attendue a un readback', () => {
  const report = transferReport(assessment, {
    ok: true,
    report: { items: [
      { clip: 0, property: 'clip.media', status: 'applied', readback: true },
      { clip: 0, property: 'video.scale', status: 'applied', readback: true },
    ] },
  });
  assert.equal(report.verified, true);
  assert.equal(report.actual.applied, 2);
});

test('une pose réussie sans readback reste cohérente mais non vérifiée', () => {
  const report = transferReport(assessment, { ok: true, count: 1 });
  assert.equal(report.coherent, true);
  assert.equal(report.verified, false);
  assert.equal(report.reason, 'readbackIncomplete');
});

test('des readbacks dupliqués ne peuvent pas masquer une propriété jamais relue', () => {
  const report = transferReport(assessment, {
    ok: true,
    report: { items: [
      { clip: 0, property: 'clip.media', status: 'applied', readback: true },
      { clip: 0, property: 'clip.media', status: 'applied', readback: true },
    ] },
  });
  assert.equal(report.actual.readbackCovered, 1);
  assert.equal(report.verified, false);
});

test('les images clés restent liées à leur propriété source', () => {
  const animated = {
    ...assessment,
    items: [
      { clip: 0, property: 'video.position', status: 'expected' },
      { clip: 0, property: 'video.position.keyframes', status: 'expected' },
      { clip: 0, property: 'video.scale', status: 'expected' },
      { clip: 0, property: 'video.scale.keyframes', status: 'expected' },
    ],
  };
  const report = transferReport(animated, {
    ok: true,
    report: { items: [
      { clip: 0, property: 'video.position', status: 'applied', readback: true },
      { clip: 0, property: 'video.position.keyframes', status: 'applied', readback: true },
      { clip: 0, property: 'video.scale', status: 'applied', readback: true },
      { clip: 0, property: 'video.scale.keyframes', status: 'applied', readback: true },
    ] },
  });
  assert.equal(report.actual.readbackCovered, 4);
  assert.equal(report.verified, true);
});

test('une animation d’échelle ne valide pas une animation de position absente', () => {
  const animated = {
    ...assessment,
    items: [
      { clip: 0, property: 'video.position.keyframes', status: 'expected' },
      { clip: 0, property: 'video.scale.keyframes', status: 'expected' },
    ],
  };
  const report = transferReport(animated, {
    ok: true,
    report: { items: [
      { clip: 0, property: 'video.scale.keyframes', status: 'applied', readback: true },
      { clip: 0, property: 'video.scale.keyframes', status: 'applied', readback: true },
    ] },
  });
  assert.equal(report.actual.readbackCovered, 1);
  assert.equal(report.verified, false);
});

test('une approximation déclarée reste non cohérente et non vérifiée', () => {
  const report = transferReport(assessment, {
    ok: true,
    report: { items: [
      { clip: 0, property: 'clip.media', status: 'applied', readback: true },
      { clip: 0, property: 'video.scale', status: 'approximated', readback: true },
    ] },
  });
  assert.equal(report.coherent, false);
  assert.equal(report.verified, false);
});

test('mismatch, média absent et piste rabattue empêchent la fidélité', () => {
  const report = transferReport(assessment, {
    ok: true, skipped: ['C:/absent.mov'], tracksClamped: true,
    report: { items: [{ property: 'video.scale', status: 'readbackMismatch', readback: true }] },
  });
  assert.equal(report.verified, false);
  assert.equal(report.actual.declaredIssues, 2);
  assert.equal(report.actual.readbackMismatch, 1);
});

test('les compteurs writers acceptent nombre ou liste', () => {
  assert.equal(countValue(3), 3);
  assert.equal(countValue(['a', 'b']), 2);
  assert.equal(countValue(undefined), 0);
});
