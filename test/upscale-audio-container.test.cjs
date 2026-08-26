// Le muxeur ne refuse un couple conteneur/codec audio qu'à l'écriture de l'en-tête, donc APRÈS le
// job : copier le FLAC d'un rush dans le .mov d'un transfert NetsuBridge tuait l'upscale entier sur
// « flac only supported in MP4 ». Le couple se tranche AVANT ffmpeg, dans le profil d'encodage.
const test = require('node:test');
const assert = require('node:assert/strict');

const { containerAcceptsAudio, writtenAudioCodec } = require('../core/export/encodeArgs');

// Sonde de pistes remplacée AVANT le require de processEncoding (qui la déstructure au chargement).
const ffmpeg = require('../core/ffmpeg');
let probed = { tracks: [] };
ffmpeg.probeAudioTracks = async () => probed;
const { audioModeForContainer } = require('../core/processEncoding');

const withSource = (codec) => { probed = { tracks: codec ? [{ index: 0, codec }] : [] }; };

test('containers refuse the audio codecs ffmpeg will not mux into them', () => {
  assert.equal(containerAcceptsAudio('mov', 'flac'), false);
  assert.equal(containerAcceptsAudio('mov', 'opus'), false);
  assert.equal(containerAcceptsAudio('mov', 'pcm_s16le'), true);
  assert.equal(containerAcceptsAudio('mp4', 'flac'), true);
  assert.equal(containerAcceptsAudio('mp4', 'pcm_s24le'), false);
  assert.equal(containerAcceptsAudio('webm', 'aac'), false);
  assert.equal(containerAcceptsAudio('webm', 'opus'), true);
  assert.equal(containerAcceptsAudio('mkv', 'flac'), true);
  // Codec inconnu ou absent : aucune contrainte inventée (mieux vaut laisser ffmpeg trancher).
  assert.equal(containerAcceptsAudio('mov', null), true);
  assert.equal(containerAcceptsAudio('mov', 'ondes_martenot'), true);
});

test('both audio vocabularies name the codec really written', () => {
  assert.equal(writtenAudioCodec('aac_320', 'flac'), 'aac');       // profils d'export
  assert.equal(writtenAudioCodec('pcm', 'flac'), 'pcm_s16le');     // export AE
  assert.equal(writtenAudioCodec('pcm24', 'flac'), 'pcm_s24le');
  assert.equal(writtenAudioCodec('copy', 'flac'), 'flac');         // le flux source tel quel
  assert.equal(writtenAudioCodec('none', 'flac'), null);
});

test('copying a stream the container refuses falls back to AAC', async () => {
  withSource('flac');
  assert.equal(await audioModeForContainer('mov', 'copy', { input: 'C:/rush/a.mkv' }), 'aac');
  assert.equal(await audioModeForContainer('mkv', 'copy', { input: 'C:/rush/a.mkv' }), 'copy');
  withSource('aac');
  assert.equal(await audioModeForContainer('mov', 'copy', { input: 'C:/rush/a.mkv' }), 'copy');
});

test('an encoded mode the container refuses falls back to AAC too', async () => {
  withSource('aac');
  assert.equal(await audioModeForContainer('mov', 'flac', { input: 'C:/rush/a.mkv' }), 'aac');
  assert.equal(await audioModeForContainer('mkv', 'flac', { input: 'C:/rush/a.mkv' }), 'flac');
});

test('a mute or unprobed source constrains nothing', async () => {
  withSource(null);
  assert.equal(await audioModeForContainer('mov', 'copy', { input: 'C:/rush/a.mkv' }), 'copy');
  assert.equal(await audioModeForContainer('mov', 'copy', {}), 'copy');
  assert.equal(await audioModeForContainer('mov', 'none', { input: 'C:/rush/a.mkv' }), 'none');
});

test('the mapped track decides, not the first one', async () => {
  probed = { tracks: [{ index: 0, codec: 'aac' }, { index: 1, codec: 'flac' }] };
  assert.equal(await audioModeForContainer('mov', 'copy', { input: 'C:/rush/a.mkv', audioTrack: 1 }), 'aac');
  assert.equal(await audioModeForContainer('mov', 'copy', { input: 'C:/rush/a.mkv', audioTrack: 0 }), 'copy');
});
