// Le conteneur ne se choisit pas dans le panneau : il se déduit des FLUX écrits. Un remux ne
// convertit rien, donc c'est le codec de la SOURCE qui doit entrer dedans — un rush ProRes
// réencapsulé en MP4 échoue au muxage et emportait l'export entier avec lui.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { videoOutExt, audioOutExt, outAudioCodec, streamCodecName } = require('../core/ae/codecs');
const { prepareMedia } = require('../core/ae/prepareMedia');

test('le MP4 est refusé aux flux qu il ne porte pas', () => {
  assert.equal(videoOutExt('mp4', 'prores', 'pcm_s16le'), 'mov');
  assert.equal(videoOutExt('mp4', 'dnxhd', 'aac'), 'mov');
  assert.equal(videoOutExt('mp4', 'h264', 'pcm_s16le'), 'mov');   // le PCM non plus n'y entre pas
  assert.equal(videoOutExt('mp4', 'h264', 'aac'), 'mp4');
  assert.equal(videoOutExt('mov', 'prores', 'pcm_s16le'), 'mov');
});

test('une piste son PCM sort en WAV, jamais en M4A', () => {
  assert.equal(audioOutExt('m4a', 'pcm_s16le'), 'wav');
  assert.equal(audioOutExt('m4a', 'aac'), 'm4a');
  assert.equal(audioOutExt('wav', 'pcm_s16le'), 'wav');
});

test('l id d encodeur du panneau se traduit en nom de flux', () => {
  // Sans cette traduction, x264 passait pour un codec inconnu et se voyait refuser le MP4 — son
  // conteneur naturel.
  assert.equal(streamCodecName('x264'), 'h264');
  assert.equal(streamCodecName('h264_nvenc'), 'h264');
  assert.equal(streamCodecName('x265'), 'hevc');
  assert.equal(streamCodecName('prores_422'), 'prores');
  assert.equal(streamCodecName('dnxhr_hq'), 'dnxhd');
});

test('les deux vocabulaires de modes audio donnent le même codec écrit', () => {
  assert.equal(outAudioCodec('aac', 'pcm_s16le'), 'aac');          // export AE
  assert.equal(outAudioCodec('aac_192', 'pcm_s16le'), 'aac');      // profils d'export
  assert.equal(outAudioCodec('copy', 'pcm_s16le'), 'pcm_s16le');
  assert.equal(outAudioCodec('none', 'pcm_s16le'), null);
});

/** Faux ffmpeg/ffprobe : la sonde rend les codecs voulus, l'encodage ne fait qu'enregistrer l'appel. */
function fakeRun(video, audio, dims = { width: 1920, height: 1080 }) {
  const calls = [];
  const run = async (bin, args) => {
    if (bin === 'ffprobe') {
      return JSON.stringify({ streams: [
        { codec_type: 'video', codec_name: video, width: dims.width, height: dims.height },
        { codec_type: 'audio', codec_name: audio },
      ] });
    }
    calls.push(args);
    return '';
  };
  return { run, calls };
}

const clip = {
  kind: 'video', track: 1, path: 'C:/rush/a.mov', name: 'a', fpsClip: 24, srcFrames: 100,
  srcIn: 0, srcOut: 47, tlStart: 0, tlEnd: 48, xf: null,
};

test('un rush ProRes demandé en MP4 est réencapsulé en MOV, et le dit', async () => {
  const { run, calls } = fakeRun('prores', 'pcm_s16le');
  const notes = [];
  const prepared = await prepareMedia({ run }, null, { items: [clip], fps: 24 }, {
    videoMode: 'remux', codec: 'prores_422', audio: 'copy', outDir: os.tmpdir(),
    videoContainer: 'mp4', fps: 24, notes,
  });
  assert.match(prepared[0].file, /\.mov$/);
  assert.equal(notes.length, 1);
  assert.deepEqual({ wanted: notes[0].wanted, used: notes[0].used }, { wanted: 'mp4', used: 'mov' });
  assert.ok(calls.some((args) => args.join(' ').includes('-c:v copy')), 'le remux doit rester une copie de flux');
});

test('un rush H.264 demandé en MP4 y reste', async () => {
  const { run } = fakeRun('h264', 'aac');
  const notes = [];
  const prepared = await prepareMedia({ run }, null, { items: [clip], fps: 24 }, {
    videoMode: 'remux', codec: 'x264', audio: 'copy', outDir: os.tmpdir(),
    videoContainer: 'mp4', fps: 24, notes,
  });
  assert.match(prepared[0].file, /\.mp4$/);
  assert.equal(notes.length, 0);
});

const ZOOMED = {
  ...clip, srcWidth: 1920, srcHeight: 1080,
  xf: { zoomX: 0.5, zoomY: 0.5, pan: 0, tilt: 0, rot: 0, anchorX: 0, anchorY: 0, opacity: 100,
    cropL: 0, cropR: 0, cropT: 0, cropB: 0, flipX: 0, flipY: 0 },
};

const bakeOpts = {
  videoMode: 'reencode', bake: true, codec: 'prores_422', audio: 'copy',
  outDir: os.tmpdir(), fps: 24, compW: 1920, compH: 1080,
};

test('le mode Réencodé cuit le cadrage DANS le fichier', async () => {
  const { run, calls } = fakeRun('h264', 'aac');
  const prepared = await prepareMedia({ run }, null, { items: [ZOOMED], fps: 24 }, { ...bakeOpts, notes: [] });
  assert.equal(prepared[0].xfBaked, true);
  const args = calls.find((a) => a.includes('-filter_complex'));
  assert.ok(args, 'aucun graphe de cuisson passé à ffmpeg');
  assert.match(args.join(' '), /scale=960:540/);
  // Le flux cuit remplace la vidéo source dans le mappage, sinon c'est le rush brut qui sort.
  assert.ok(args.includes('[v]'));
});

test('le cadrage se cuit même quand Resolve ne dit pas les dimensions de la source', async () => {
  // Mesuré : la propriété « Resolution » du Media Pool revient parfois vide. La cuisson était alors
  // abandonnée en silence et le cadrage repartait dans AE — indiscernable d'un mode ignoré.
  const { run, calls } = fakeRun('h264', 'aac');
  const prepared = await prepareMedia({ run }, null,
    { items: [{ ...ZOOMED, srcWidth: 0, srcHeight: 0 }], fps: 24 }, { ...bakeOpts, notes: [] });
  assert.equal(prepared[0].xfBaked, true);
  assert.match(calls.find((a) => a.includes('-filter_complex')).join(' '), /scale=960:540/);
});

test('une propriété ANIMÉE n est pas cuite par ffmpeg : elle serait figée sur une valeur', async () => {
  const { run } = fakeRun('h264', 'aac');
  const animated = { ...ZOOMED, anim: { scale: { value: { x: 1, y: 1 }, keyframes: [{ frame: 0, value: { x: 1, y: 1 } }] } } };
  const prepared = await prepareMedia({ run }, null, { items: [animated], fps: 24 }, { ...bakeOpts, notes: [] });
  // Ces plans-là passent par le rendu Resolve, en amont (cf. ae-bake-transform).
  assert.ok(!prepared[0].xfBaked, 'le cadrage animé ne doit pas être cuit ici');
});

test('un plan déjà rendu par Resolve n est plus retouché', async () => {
  const { run, calls } = fakeRun('h264', 'aac');
  const rendered = { ...ZOOMED, path: 'C:/out/2_bake_300.mov', rendered: true, xf: null };
  const prepared = await prepareMedia({ run }, null, { items: [rendered], fps: 24 }, { ...bakeOpts, notes: [] });
  assert.equal(prepared[0].file, 'C:/out/2_bake_300.mov');
  assert.equal(calls.length, 0, 'aucun ffmpeg ne doit tourner sur un plan déjà cuit');
});

test('un réencode ProRes ignore le conteneur MP4 hérité d un autre mode', async () => {
  const { run } = fakeRun('h264', 'aac');
  const notes = [];
  const prepared = await prepareMedia({ run }, null, { items: [clip], fps: 24 }, {
    videoMode: 'reencode', codec: 'prores_422', audio: 'copy', outDir: os.tmpdir(),
    videoContainer: 'mp4', fps: 24, notes,
  });
  assert.match(prepared[0].file, /\.mov$/);
  assert.equal(notes.length, 1);
});
