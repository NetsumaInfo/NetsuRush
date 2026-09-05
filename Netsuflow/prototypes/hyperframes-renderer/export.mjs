// Writing a composition out as something another program can open.
//
// Distinct from the bake, and the distinction matters because they were briefly
// confused with each other. The bake is a cache: raw RGBA named by frame key,
// readable only by this service, existing so the host reads instead of
// re-rendering. An export is a deliverable: a PNG sequence or a movie, at a path
// the user chose, that Resolve or anything else can import.
//
// Frames come through the same scheduler the node and the editor use, so an
// export of a baked composition costs a disk read per frame rather than a
// capture — and an export of an unbaked one fills the bake as it goes.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { encodePng } from './pngEncode.mjs';

/// Where ffmpeg is, in the order a build would look.
///
/// Never a silent fallback to "no video export": a missing encoder has to be
/// reported as such, because the alternative is an export button that quietly
/// only ever produces PNGs.
export function resolveFfmpeg(explicit) {
  const candidates = [
    explicit,
    process.env.NETSUFLOW_FFMPEG,
    'S:/projet_app/NetsuRush/build/ffmpeg-mirror/ffmpeg-9.0-win64/ffmpeg.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: whatever is on PATH. Spawning resolves it, and a failure to
  // spawn is reported with the rest.
  return 'ffmpeg';
}

export const FORMATS = {
  png: {
    label: 'Séquence PNG',
    detail: 'un fichier par image, alpha conservé',
    extension: 'png',
    needsFfmpeg: false,
    alpha: true,
  },
  prores4444: {
    label: 'ProRes 4444',
    detail: 'un .mov, alpha conservé',
    extension: 'mov',
    needsFfmpeg: true,
    alpha: true,
    args: () => [
      '-c:v', 'prores_ks', '-profile:v', '4444',
      '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16',
    ],
  },
  h264: {
    label: 'H.264',
    detail: 'un .mp4, sans alpha (composité sur du noir)',
    extension: 'mp4',
    needsFfmpeg: true,
    alpha: false,
    args: (options) => [
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-crf', String(options.quality ?? 18), '-preset', 'medium',
    ],
  },
};

/// Straight alpha composited onto black, in place.
///
/// Only for the formats that cannot carry alpha. Doing nothing instead would
/// hand libx264 straight colour at full strength wherever the composition is
/// transparent, which reads as a bright fringe around everything soft.
function flattenOntoBlack(pixels) {
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha === 255) continue;
    pixels[i] = (pixels[i] * alpha + 127) / 255;
    pixels[i + 1] = (pixels[i + 1] * alpha + 127) / 255;
    pixels[i + 2] = (pixels[i + 2] * alpha + 127) / 255;
    pixels[i + 3] = 255;
  }
  return pixels;
}

function sanitiseName(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned === '' ? 'composition' : cleaned.slice(0, 80);
}

/**
 * @param {object} options
 * @param {string} options.format          key of FORMATS
 * @param {string} options.directory       absolute destination directory
 * @param {string} options.name            base file name
 * @param {number} options.from            first frame, inclusive
 * @param {number} options.to              last frame, inclusive
 * @param {number} options.width
 * @param {number} options.height
 * @param {number} options.fps
 * @param {(frame:number)=>Promise<Buffer>} options.renderFrame
 * @param {object} options.progress        mutated as the run advances
 * @param {string} [options.ffmpegPath]
 * @param {number} [options.quality]
 */
export async function runExport(options) {
  const format = FORMATS[options.format];
  if (!format) throw new Error(`format inconnu : ${options.format}`);

  const directory = options.directory;
  if (typeof directory !== 'string' || directory === '' || !isAbsolute(directory)) {
    throw new Error('le dossier de destination doit être un chemin absolu');
  }
  const from = Math.max(0, Math.trunc(options.from ?? 0));
  const to = Math.trunc(options.to ?? 0);
  if (!(to >= from)) throw new Error('la plage de frames est vide');

  const name = sanitiseName(options.name);
  mkdirSync(directory, { recursive: true });

  const progress = options.progress;
  progress.running = true;
  progress.done = 0;
  progress.total = to - from + 1;
  progress.error = null;
  progress.output = format.extension === 'png'
    ? join(directory, `${name}_#####.png`)
    : join(directory, `${name}.${format.extension}`);

  try {
    if (format.needsFfmpeg) {
      await exportThroughFfmpeg({ ...options, format, directory, name, from, to, progress });
    } else {
      await exportPngSequence({ ...options, directory, name, from, to, progress });
    }
  } catch (error) {
    progress.error = error.message;
    throw error;
  } finally {
    progress.running = false;
  }
  return { output: progress.output, frames: progress.done };
}

async function exportPngSequence({ directory, name, from, to, width, height, renderFrame, progress }) {
  for (let frame = from; frame <= to; frame += 1) {
    if (progress.cancelled) throw new Error('export annulé');
    const pixels = await renderFrame(frame);
    const index = String(frame).padStart(5, '0');
    writeFileSync(join(directory, `${name}_${index}.png`), encodePng(pixels, width, height));
    progress.done = frame - from + 1;
  }
}

function exportThroughFfmpeg(options) {
  const { format, directory, name, from, to, width, height, fps, renderFrame, progress } = options;
  const output = join(directory, `${name}.${format.extension}`);
  const binary = resolveFfmpeg(options.ffmpegPath);

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
    ...format.args(options),
    output,
  ];

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      reject(new Error(`ffmpeg introuvable (${binary}) : ${error.message}`));
      return;
    }

    // ffmpeg says why it failed on stderr and nowhere else, and the last lines
    // are the ones that name the reason.
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    let finished = false;
    const fail = (message) => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(message));
    };

    child.on('error', (error) => fail(`ffmpeg n'a pas démarré (${binary}) : ${error.message}`));
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (code === 0) {
        progress.output = output;
        resolvePromise();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-4).join(' · ');
      reject(new Error(`ffmpeg a échoué (code ${code}) : ${tail}`));
    });

    void (async () => {
      try {
        for (let frame = from; frame <= to; frame += 1) {
          if (finished) return;
          if (progress.cancelled) {
            fail('export annulé');
            return;
          }
          const pixels = await renderFrame(frame);
          const payload = format.alpha ? pixels : flattenOntoBlack(Buffer.from(pixels));
          // Respecting back-pressure: a 1080x1920 frame is 8.3 MiB, and pushing
          // 340 of them into a pipe that is not draining buffers gigabytes in
          // this process rather than in the encoder.
          if (!child.stdin.write(payload)) {
            await new Promise((drained) => child.stdin.once('drain', drained));
          }
          progress.done = frame - from + 1;
        }
        child.stdin.end();
      } catch (error) {
        fail(error.message);
      }
    })();
  });
}
