const test = require('node:test');
const assert = require('node:assert/strict');

const { readResolveProperties } = require('../core/transfer/readResolveProperties');

test('le lecteur Resolve garde identité et mix audio réellement exposé', async () => {
  const values = { AudioGain: -6, Volume: 0.5, Pan: 0.25, Mute: true };
  const item = {
    GetUniqueId: async () => 'resolve-audio-1',
    GetProperty: async (key) => values[key],
  };
  const out = await readResolveProperties(item, 'audio');
  assert.equal(out.nativeId, 'resolve-audio-1');
  assert.equal(out.audio.gainDb.value, -6);
  assert.equal(out.audio.volume.value, 0.5);
  assert.equal(out.audio.pan.value, 0.25);
  assert.equal(out.audio.mute.value, true);
  assert.equal(out.audio.gainDb.source.host, 'resolve');
});

test('une propriété audio absente ne reçoit aucune valeur inventée', async () => {
  const item = {
    GetUniqueId: async () => null,
    GetProperty: async () => undefined,
  };
  const out = await readResolveProperties(item, 'audio');
  assert.equal(out.nativeId, undefined);
  assert.equal(out.audio, undefined);
});

test('un plan vidéo ne lit pas les clés audio homonymes', async () => {
  let reads = 0;
  const item = {
    GetUniqueId: async () => 'video-1',
    GetProperty: async () => { reads++; return 1; },
  };
  const out = await readResolveProperties(item, 'video');
  assert.equal(out.nativeId, 'video-1');
  assert.equal(out.audio, undefined);
  assert.equal(reads, 0);
});
