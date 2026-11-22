// @ts-check
// Video processing (the "Traitements" hub): AI upscale, real-time shader upscale, frame interpolation,
// depth maps, background removal, and ordered chains of them. Every action reads a source file and
// WRITES new files into `outDir`; none overwrites the source. They are GPU jobs of minutes to hours.

const nodePath = require('node:path');
const { WAIT_PARAM } = require('./domain');

/** @type {Record<string, string>} */
const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg' };

/**
 * Hands the produced files back to the MCP layer. A sequence output is a folder: it stays in
 * `outputs`, only real files become resource links.
 * @param {any} r
 */
function withOutputs(r) {
  if (!r || typeof r !== 'object') return r;
  const outs = (Array.isArray(r.outputs) ? r.outputs : []).filter((f) => typeof f === 'string' && nodePath.extname(f));
  if (!outs.length) return r;
  return {
    ...r,
    __files: outs.map((f) => ({ path: f, name: nodePath.basename(f), mimeType: MIME[nodePath.extname(f).toLowerCase()] || 'application/octet-stream' })),
  };
}

/**
 * The options every processing action shares, in the shape the engines read.
 * @param {any} a
 * @param {Record<string, any>} extra engine-specific fields
 */
function common(a, extra) {
  /** @type {Record<string, any>} */
  const o = { input: a.input, outDir: a.outDir, ...extra };
  for (const k of ['segments', 'whole', 'importBack', 'baseName', 'outputName', 'outputKind', 'imageFormat',
    'exportCodec', 'container', 'audioMode', 'encoderMode', 'speed', 'audioTrack', 'dedup']) {
    if (a[k] !== undefined) o[k] = a[k];
  }
  return o;
}

/** @param {Record<string, any>} o drops undefined keys so the engine defaults apply */
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const SHARED_NOTE = 'Shared: segments? [{in, out}] (seconds; one output file per segment) or whole:true (default, the entire file), '
  + 'importBack? (add outputs to the Resolve Media Pool), outputName?, baseName?, outputKind? "video"|"image"|"sequence", '
  + 'exportCodec? (e.g. "h264_high", "h265_main10", "prores_422"; see netsu_export capabilities), container? "mp4"|"mkv"|"mov", '
  + 'audioMode? (copy|none|aac...), encoderMode? "gpu"|"cpu", speed? "fast"|"balanced"|"quality"|"max".';

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_process',
  summary: 'Video processing jobs (GPU, minutes to hours): upscale, shader upscale, frame interpolation, depth, background removal, '
    + 'and chains. Each reads `input` (absolute path) and writes NEW files into `outDir` (required, absolute); the source is never overwritten. '
    + 'Models must be installed first: list them with netsu_models (task upscale / interpolate / depth / matte). '
    + 'The result carries outputs[] (and files). Only one heavy job should run at a time: check netsu_jobs before starting another. '
    + SHARED_NOTE,
  actions: {
    upscale: {
      risk: 'write', long: true,
      usage: 'upscale(input, outDir, model?, scale?, targetHeight?, denoise?, tile?, fp32?, quality?, bitDepth?, ...shared) — AI upscale. '
        + 'model default "light" (see netsu_models, task upscale / restore); scale 2|4 (default 4); targetHeight 1080|1440|2160 fits a resolution class instead of a factor; '
        + 'denoise 0..1 (models that support it); tile = tile size in px for low-VRAM GPUs (0 = auto); quality = CRF-like (default 20); bitDepth 8|10.',
      channel: 'upscale:run',
      args: (a) => [common(a, defined({
        model: a.model, scale: a.scale, targetHeight: a.targetHeight, denoise: a.denoise, tile: a.tile, fp32: a.fp32,
        quality: a.quality, bitDepth: a.bitDepth, cleanupNoise: a.cleanupNoise, cleanupEdges: a.cleanupEdges,
      }))],
      map: withOutputs,
    },
    shader_upscale: {
      risk: 'write', long: true,
      usage: 'shader_upscale(input, outDir, shader, scale?, targetHeight?, ...shared) — real-time upscale (much faster, lighter result than AI). '
        + 'shader ids: artcnn_c4f32, artcnn_c4f32_ds, artcnn_c4f32_dn, artcnn_c4f16, artcnn_c4f16_ds, artcnn_c4f16_dn, artcnn_quality, anime4k, anime4k_aa_hq, '
        + 'anime4k_bb_hq, lanczos, artcnn_r16f96, artcnn_r8f64 (ONNX weights) and rtx_vsr (NVIDIA RTX Video SDK: x2 only, MP4 video only, needs its DLLs installed).',
      channel: 'upscale:shaderRun',
      args: (a) => [common(a, defined({ shader: a.shader, scale: a.scale, targetHeight: a.targetHeight }))],
      map: withOutputs,
    },
    interpolate: {
      risk: 'write', long: true,
      usage: 'interpolate(input, outDir, model?, factor?, targetFps?, slowmo?, dedup?, ...shared) — frame interpolation (RIFE and friends). '
        + 'model default "rife-v4.6"; factor 2|3|4 (frame multiplier, default 2); targetFps overrides factor; slowmo:true keeps the original fps so the clip plays slower; '
        + 'dedup:true drops duplicated frames first (anime on twos).',
      channel: 'process:interpolate',
      args: (a) => [common(a, defined({ model: a.model, factor: a.factor, targetFps: a.targetFps, slowmo: a.slowmo }))],
      map: withOutputs,
    },
    depth: {
      risk: 'write', long: true,
      usage: 'depth(input, outDir, model?, bits?, colormap?, ...shared) — depth-map video. model default "depth-anything-v2-small" (see netsu_models, task depth); '
        + 'bits 8|16; colormap "gray" (default) or a named colormap.',
      channel: 'process:depth',
      args: (a) => [common(a, defined({ model: a.model, bits: a.bits, colormap: a.colormap }))],
      map: withOutputs,
    },
    remove_bg: {
      risk: 'write', long: true,
      usage: 'remove_bg(input, outDir, model?, format?, despeckle?, edgeSmoothing?, edgeOffset?, ...shared) — background removal with an alpha channel. '
        + 'model default "isnet-anime" (see netsu_models, task matte); format "prores_4444" (default, .mov) | "png_seq" (RGBA PNG folder); '
        + 'a vp9 exportCodec gives WebM alpha. despeckle / edgeSmoothing / edgeOffset are integer pixel clean-ups of the matte.',
      channel: 'process:removeBg',
      args: (a) => [common(a, defined({
        model: a.model, format: a.format, despeckle: a.despeckle, edgeSmoothing: a.edgeSmoothing, edgeOffset: a.edgeOffset,
      }))],
      map: withOutputs,
    },
    pipeline: {
      risk: 'write', long: true,
      usage: 'pipeline(input, outDir, ops[], importBack?, baseName?, outputName?) — chain upscale and/or interpolate on ONE source into ONE output file '
        + '(each op feeds the next; intermediates are deleted). ops: [{kind: "upscale"|"interpolate", settings}] where upscale settings = '
        + '{engine?: "ia"|"turbo", model?, shader? (turbo), scale?, targetHeight?, mode?: "upscale"|"restore"} and interpolate settings = {model?, factor?, targetFps?}. '
        + 'depth and removeBg do not chain.',
      channel: 'pipeline:run',
      args: (a) => [defined({
        input: a.input, outDir: a.outDir, ops: a.ops || [], importBack: a.importBack, baseName: a.baseName, outputName: a.outputName,
      })],
      map: withOutputs,
    },
  },
  params: {
    input: { type: 'string', description: 'Absolute path of the source video (or image)' },
    outDir: { type: 'string', description: 'Absolute output folder (created if missing)' },
    model: { type: 'string', description: 'Model id (installed models: netsu_models list)' },
    shader: { type: 'string', description: 'Real-time shader id (see shader_upscale)' },
    scale: { type: 'number', description: 'Upscale factor, 2 or 4' },
    targetHeight: { type: 'number', description: 'Resolution class: 1080, 1440 or 2160 (0 = use the factor)' },
    denoise: { type: 'number' },
    tile: { type: 'number', description: 'Tile size in px (0 = automatic)' },
    fp32: { type: 'boolean' },
    quality: { type: 'number', description: 'Encode quality, lower = better (default 20)' },
    bitDepth: { type: 'number', enum: [8, 10] },
    cleanupNoise: { type: 'number' },
    cleanupEdges: { type: 'number' },
    factor: { type: 'number', description: 'Interpolation frame multiplier (2, 3 or 4)' },
    targetFps: { type: 'number' },
    slowmo: { type: 'boolean' },
    dedup: { type: 'boolean', description: 'Drop duplicated source frames first' },
    bits: { type: 'number', enum: [8, 16] },
    colormap: { type: 'string' },
    format: { type: 'string', description: 'Matte format: prores_4444 | png_seq' },
    despeckle: { type: 'number' },
    edgeSmoothing: { type: 'number' },
    edgeOffset: { type: 'number' },
    segments: {
      type: 'array',
      items: { type: 'object', properties: { in: { type: 'number' }, out: { type: 'number' } }, required: ['in', 'out'] },
      description: 'Seconds ranges; one output per segment',
    },
    whole: { type: 'boolean', description: 'Process the entire file (default when no segments)' },
    importBack: { type: 'boolean', description: 'Import the outputs into the Resolve Media Pool' },
    baseName: { type: 'string' },
    outputName: { type: 'string', description: 'Exact output file name stem (no counter suffix)' },
    outputKind: { type: 'string', enum: ['video', 'image', 'sequence'] },
    imageFormat: { type: 'string', enum: ['png', 'jpeg'] },
    exportCodec: { type: 'string', description: 'Output codec id, e.g. h264_high, h265_main10, prores_422' },
    container: { type: 'string', enum: ['mp4', 'mkv', 'mov'] },
    audioMode: { type: 'string', description: 'copy | none | aac | aac_256 | ...' },
    encoderMode: { type: 'string', enum: ['gpu', 'nvenc', 'amf', 'qsv', 'cpu'] },
    speed: { type: 'string', enum: ['fast', 'balanced', 'quality', 'max'] },
    audioTrack: { type: 'number', description: 'Audio track index (a:N) to keep' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['upscale', 'interpolate'] }, settings: { type: 'object' } },
        required: ['kind'],
      },
    },
    ...WAIT_PARAM,
  },
};
