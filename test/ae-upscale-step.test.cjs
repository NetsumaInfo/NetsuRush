// Agrandir pendant un transfert doit passer par le MÊME moteur que NetsuLab et que l'archivage
// d'une collection : un quatrième chemin vers les modèles les ferait diverger. Ces tests tiennent la
// traduction « réglages du panneau → moteur » et la place de l'agrandissement dans la préparation.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { upscaleStep, aeEncoding } = require('../core/ae/upscaleStep');
const { prepareMedia } = require('../core/ae/prepareMedia');

const engines = {
  runUpscale: async (args) => ({ ok: true, outputs: [args.savePath], engine: 'ia', args }),
  runTurbo: async (args) => ({ ok: true, outputs: [args.savePath], engine: 'turbo', args }),
};

test('option éteinte : aucune étape d agrandissement', () => {
  assert.equal(upscaleStep(undefined, engines, {}, 'mp4'), null);
  assert.equal(upscaleStep({ enabled: false, model: 'anime' }, engines, {}, 'mp4'), null);
});

test('moteur non injecté : on n invente pas d agrandissement', () => {
  assert.equal(upscaleStep({ enabled: true, model: 'anime' }, {}, {}, 'mp4'), null);
});

test('le moteur suit le mode, comme dans le panneau Traitements', () => {
  const ia = upscaleStep({ enabled: true, engine: 'turbo', mode: 'restore', model: 'anime' }, engines, {}, 'mov');
  // « Restaurer » n'a pas d'équivalent shader : il force l'IA, échelle 1×.
  assert.equal(ia.engine, 'ia');
  assert.equal(ia.scale, 1);
  const turbo = upscaleStep({ enabled: true, engine: 'turbo', mode: 'upscale', shader: 'rtx_vsr', scale: 4 }, engines, {}, 'mp4');
  assert.equal(turbo.engine, 'turbo');
  assert.equal(turbo.scale, 2);   // échelle imposée par le SDK NVIDIA
});

test('le traitement audio du panneau AE se traduit pour le moteur', () => {
  // Le PCM n'a pas d'équivalent côté moteur : la copie du flux est ce qui s'en approche sans perte.
  assert.equal(aeEncoding('x264', 'pcm', 192).audio, 'copy');
  assert.equal(aeEncoding('x264', 'remux', 192).audio, 'copy');
  assert.equal(aeEncoding('x264', 'aac', 256).audio, 'aac');
  assert.equal(aeEncoding('x264', 'none', 192).audio, 'none');
});

const clip = {
  kind: 'video', track: 1, path: 'C:/rush/a.mov', name: 'a', fpsClip: 24, srcFrames: 240,
  srcIn: 24, srcOut: 71, tlStart: 0, tlEnd: 48, xf: null,
};

const fakeFfmpeg = () => {
  const calls = [];
  return {
    calls,
    run: async (bin, args) => {
      if (bin === 'ffprobe') {
        return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }] });
      }
      calls.push(args);
      return '';
    },
  };
};

test('l agrandissement REMPLACE le réencode et découpe lui-même le plan', async () => {
  const { run, calls } = fakeFfmpeg();
  let seen = null;
  const step = upscaleStep({ enabled: true, model: 'anime', scale: 2 },
    { runUpscale: async (args) => { seen = args; return { ok: true, outputs: [args.savePath] }; } },
    aeEncoding('x264', 'copy', 192), 'mp4');
  const prepared = await prepareMedia({ run }, null, { items: [clip], fps: 24 }, {
    videoMode: 'reencode', codec: 'x264', audio: 'copy', outDir: os.tmpdir(), fps: 24, upscale: step, notes: [],
  });
  assert.equal(calls.length, 0, 'aucun réencode ffmpeg : le moteur encode lui-même');
  // Bornes en SECONDES, borne de sortie EXCLUSIVE (srcOut est inclusif côté Resolve).
  assert.deepEqual(seen.segments, [{ in: 1, out: 3 }]);
  assert.equal(seen.whole, false);
  assert.equal(seen.importBack, false);
  // Le fichier produit EST le plan : ses bornes repartent de zéro.
  assert.equal(prepared[0].fileInFrame, 0);
  assert.match(prepared[0].file, /\.mp4$/);
});

test('un plan déjà rendu par Resolve est agrandi ENTIER, sans redécoupe', async () => {
  const { run } = fakeFfmpeg();
  let seen = null;
  const step = upscaleStep({ enabled: true, model: 'anime' },
    { runUpscale: async (args) => { seen = args; return { ok: true, outputs: [args.savePath] }; } },
    aeEncoding('x264', 'copy', 192), 'mp4');
  await prepareMedia({ run }, null, { items: [{ ...clip, rendered: true, srcIn: 0, srcOut: 47 }], fps: 24 }, {
    videoMode: 'reencode', codec: 'x264', audio: 'copy', outDir: os.tmpdir(), fps: 24, upscale: step, notes: [],
  });
  assert.equal(seen.whole, true);
  assert.deepEqual(seen.segments, []);
});

test('un agrandissement en échec ne laisse pas passer un fichier vide', async () => {
  const { run } = fakeFfmpeg();
  const step = upscaleStep({ enabled: true, model: 'anime' },
    { runUpscale: async () => ({ ok: false, error: 'modèle absent' }) },
    aeEncoding('x264', 'copy', 192), 'mp4');
  await assert.rejects(
    prepareMedia({ run }, null, { items: [clip], fps: 24 }, {
      videoMode: 'reencode', codec: 'x264', audio: 'copy', outDir: os.tmpdir(), fps: 24, upscale: step, notes: [],
    }),
    /mod√®le absent|modèle absent/,
  );
});
