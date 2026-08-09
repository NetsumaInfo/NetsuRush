// Registre des sorties d'upscale : c'est lui qui empêche de repayer des minutes de GPU pour un plan
// déjà produit. Les deux propriétés qui comptent : l'empreinte change quand — et SEULEMENT quand —
// le contenu du fichier changerait, et une entrée qui promet un fichier disparu est purgée.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUpscaleLedger, fingerprint } = require('../core/upscaleLedger.js');

const ENCODE = { workflow: 'video_encode', codec: 'h264_high', encoderMode: 'gpu', speed: 'balanced', container: 'mp4', audioMode: 'copy' };
const SHOT = { src: 'S:/rush/A.mkv', mtimeMs: 1000, size: 42, in: 1.5, out: 3.25 };
const UP = { enabled: true, engine: 'ia', model: 'fallin', scale: 2 };

function tmpLedger() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-ledger-'));
  return { root, ledger: createUpscaleLedger({ file: path.join(root, 'ledger.json') }) };
}

test('fingerprint is stable and insensitive to key order', () => {
  const a = fingerprint({ ...SHOT, encode: ENCODE, upscale: UP });
  const b = fingerprint({
    upscale: { scale: 2, model: 'fallin', engine: 'ia', enabled: true },
    encode: { audioMode: 'copy', container: 'mp4', speed: 'balanced', encoderMode: 'gpu', codec: 'h264_high', workflow: 'video_encode' },
    out: SHOT.out, in: SHOT.in, size: SHOT.size, mtimeMs: SHOT.mtimeMs, src: SHOT.src,
  });
  assert.equal(a, b);
});

test('fingerprint changes when anything that shapes the file changes', () => {
  const ref = fingerprint({ ...SHOT, encode: ENCODE, upscale: UP });
  const variants = {
    'source retouchée': { ...SHOT, mtimeMs: 2000 },
    'taille différente': { ...SHOT, size: 43 },
    'bornes du plan': { ...SHOT, out: 3.5 },
    'autre codec': { ...SHOT, encode: { ...ENCODE, codec: 'hevc_main' } },
    'autre modèle': { ...SHOT, upscale: { ...UP, model: 'light' } },
    'autre échelle': { ...SHOT, upscale: { ...UP, scale: 4 } },
    'upscale éteint': { ...SHOT, upscale: null },
  };
  for (const [label, v] of Object.entries(variants)) {
    assert.notEqual(fingerprint({ encode: ENCODE, upscale: UP, ...v }), ref, label);
  }
});

test('a millisecond of float noise does not invalidate a shot', () => {
  const a = fingerprint({ ...SHOT, in: 1.5, encode: ENCODE, upscale: UP });
  const b = fingerprint({ ...SHOT, in: 1.5 + 1e-9, encode: ENCODE, upscale: UP });
  assert.equal(a, b);
});

test('lookup prunes an entry whose file is gone', () => {
  const { root, ledger } = tmpLedger();
  try {
    const out = path.join(root, 'A_001.mp4');
    fs.writeFileSync(out, 'x');
    ledger.record('k1', out, { engine: 'ia', model: 'fallin', scale: 2 });
    assert.equal(ledger.lookup('k1').file, out);

    fs.rmSync(out);
    assert.equal(ledger.lookup('k1'), null, 'un registre qui promet un fichier absent est pire que rien');
    assert.equal(ledger.size(), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('describe recognises our own output, so it is never upscaled twice', () => {
  const { root, ledger } = tmpLedger();
  try {
    const out = path.join(root, 'A_001.mp4');
    fs.writeFileSync(out, 'x');
    ledger.record('k1', out, { engine: 'turbo', model: 'artcnn_c4f32', scale: 2 });

    // Casse et séparateurs : le même fichier, écrit autrement, doit être reconnu.
    const same = ledger.describe(out.replace(/\//g, path.sep).toUpperCase());
    assert.equal(same && same.scale, 2);
    assert.equal(ledger.describe(path.join(root, 'inconnu.mp4')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a ledger survives a restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-ledger-'));
  try {
    const file = path.join(root, 'ledger.json');
    const out = path.join(root, 'A_001.mp4');
    fs.writeFileSync(out, 'x');
    createUpscaleLedger({ file }).record('k1', out, { scale: 4 });

    const reopened = createUpscaleLedger({ file });
    assert.equal(reopened.lookup('k1').file, out);
    assert.equal(reopened.describe(out).scale, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
