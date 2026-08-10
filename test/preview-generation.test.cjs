const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectProxyEncoder, proxyVideoArgs, proxyContainerArgs } = require('../core/proxyEncoder');
const { normalizeThumbSettings, thumbKey, thumbKeyFromSuffix, thumbArgs } = require('../core/thumbs');
const { THUMB_PRESETS, thumbKeySuffix, thumbKeyVariants, resolveThumbSettings } = require('../core/thumbPresets');
const { proxyFrameSource } = require('../core/proxy');
const { createCacheAdmin } = require('../core/cacheAdmin');
const { getProxyDir, getThumbDir, setCacheDir } = require('../core/config');

const caps = {
  h264Encoder: 'h264_nvenc',
  h265Encoder: 'hevc_nvenc',
  codecEncoderOptions: {
    h264_main: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
    h265_main: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
  },
};

test('selects the requested hardware engine from probed multi-vendor options', () => {
  assert.equal(selectProxyEncoder('hevc', caps, 'amf').encoder, 'hevc_amf');
  assert.equal(selectProxyEncoder('h264', caps, 'qsv').encoder, 'h264_qsv');
  assert.equal(selectProxyEncoder('hevc', caps, 'auto').encoder, 'hevc_nvenc');
});

test('keeps explicit CPU codecs instead of silently changing the requested format', () => {
  const hevc = selectProxyEncoder('hevc', caps, 'cpu');
  const h264 = selectProxyEncoder('h264', caps, 'cpu');
  assert.equal(hevc.encoder, 'libx265');
  assert.equal(hevc.outputCodec, 'hevc');
  assert.equal(h264.encoder, 'libx264');
  assert.equal(h264.outputCodec, 'h264');
});

test('uses the universal CPU fallback when automatic HEVC hardware encoding is unavailable', () => {
  const fallback = selectProxyEncoder('hevc', {
    h264Encoder: null,
    h265Encoder: null,
    codecEncoderOptions: {},
  }, 'auto');
  assert.equal(fallback.encoder, 'libx264');
  assert.equal(fallback.outputCodec, 'h264');
});

test('maps the three preset levels to engine-native FFmpeg arguments', () => {
  const nvenc = selectProxyEncoder('hevc', caps, 'nvenc');
  const amf = selectProxyEncoder('h264', caps, 'amf');
  const qsv = selectProxyEncoder('h264', caps, 'qsv');
  assert.ok(proxyVideoArgs(nvenc, 'level1').includes('p1'));
  assert.ok(proxyVideoArgs(nvenc, 'level3').includes('p7'));
  assert.ok(proxyVideoArgs(amf, 'level2').includes('balanced'));
  assert.ok(proxyVideoArgs(qsv, 'level2').includes('medium'));
});

test('builds browser-compatible MP4 and WebM proxies', () => {
  const hevc = selectProxyEncoder('hevc', caps, 'nvenc');
  const h264 = selectProxyEncoder('h264', caps, 'nvenc');
  const webm = selectProxyEncoder('vp8', caps, 'auto');
  assert.equal(hevc.container, 'mp4');
  assert.equal(h264.container, 'mp4');
  assert.equal(webm.container, 'webm');
  assert.ok(proxyVideoArgs(hevc, 'level1').includes('yuv420p'));
  assert.ok(proxyVideoArgs(h264, 'level1').includes('yuv420p'));
  assert.ok(proxyVideoArgs(webm, 'level1').includes('realtime'));
  assert.deepEqual(proxyContainerArgs(hevc), ['-tag:v', 'hvc1']);
  assert.deepEqual(proxyContainerArgs(h264), []);
  assert.deepEqual(proxyContainerArgs(webm), []);
});

test('resolves a thumbnail quality step into height and per-codec encoder settings', () => {
  assert.deepEqual(normalizeThumbSettings({ format: 'webp', preset: 'light' }), { format: 'webp', preset: 'light', ...THUMB_PRESETS.light });
  assert.deepEqual(normalizeThumbSettings({ format: 'jpeg', preset: 'sharp' }), { format: 'jpeg', preset: 'sharp', ...THUMB_PRESETS.sharp });
  // Repli sur le cran équilibré : une vignette absente coûte plus cher qu'une vignette au mauvais cran.
  assert.equal(normalizeThumbSettings({ format: 'invalid', preset: 'nope' }).preset, 'balanced');
  assert.equal(normalizeThumbSettings(null).format, 'webp');
  assert.equal(normalizeThumbSettings({ format: 'jpeg' }).format, 'jpeg');
});

test('migrates the previous height/quality thumbnail settings onto a quality step', () => {
  // Un réglage déjà écrit en localStorage ne doit pas se perdre au premier lancement.
  assert.equal(normalizeThumbSettings({ format: 'webp', height: 360, quality: 70 }).preset, 'light');
  assert.equal(normalizeThumbSettings({ format: 'webp', height: 720, quality: 92 }).preset, 'sharp');
  // 520 rejoint le palier voisin, il ne dégringole pas au cran le plus bas.
  assert.equal(normalizeThumbSettings({ format: 'webp', height: 520, quality: 82 }).preset, 'balanced');
  assert.equal(normalizeThumbSettings({ format: 'webp', height: 480, quality: 82 }).preset, 'balanced');
});

test('versions thumbnail cache keys by format and quality step', () => {
  const at = (settings) => thumbKey('C:\\rush.mkv', 1.25, settings);
  const keys = new Set([
    at({ format: 'webp', preset: 'light' }),
    at({ format: 'webp', preset: 'balanced' }),
    at({ format: 'webp', preset: 'sharp' }),
    at({ format: 'jpeg', preset: 'balanced' }),
  ]);
  assert.equal(keys.size, 4, 'chaque couple format/cran doit avoir sa propre clé');
  // La clé encode les paramètres RÉSOLUS, pas l'id du cran : retoucher la table ci-dessous change le
  // suffixe, donc invalide le cache d'elle-même au lieu de resservir d'anciennes vignettes.
  const { height, webpQuality, webpEffort, jpegQscale } = THUMB_PRESETS.sharp;
  assert.match(thumbKeySuffix(resolveThumbSettings({ format: 'webp', preset: 'sharp' })), new RegExp(`^webp-${height}-q${webpQuality}e${webpEffort}-`));
  assert.match(thumbKeySuffix(resolveThumbSettings({ format: 'jpeg', preset: 'sharp' })), new RegExp(`^jpeg-${height}-q${jpegQscale}-`));
});

test('maps each quality step onto the encoder flags that drive size and generation speed', () => {
  const args = (settings) => thumbArgs('C:\\rush.mkv', 1.25, settings);
  const light = args({ format: 'webp', preset: 'light' });
  const sharp = args({ format: 'webp', preset: 'sharp' });
  assert.ok(light.includes('libwebp'));
  assert.equal(light[light.indexOf('-compression_level') + 1], String(THUMB_PRESETS.light.webpEffort));
  assert.equal(sharp[sharp.indexOf('-compression_level') + 1], String(THUMB_PRESETS.sharp.webpEffort));
  // -compression_level échange du TEMPS contre de la TAILLE, à qualité constante — il ne rend donc
  // jamais un cran plus net. Mesuré : le genou est à 2, au-delà c'est +12 % de temps pour 6 % de
  // taille. Aucun cran ne doit le dépasser, sinon on paie des millisecondes par vignette pour rien.
  for (const params of Object.values(THUMB_PRESETS)) assert.ok(params.webpEffort <= 2);
  assert.equal(light[light.indexOf('-quality') + 1], String(THUMB_PRESETS.light.webpQuality));
  assert.ok(light.includes('scale=-2:360'));
  // La finesse vient de la hauteur et de -quality, qui doivent bien monter avec le cran.
  assert.ok(THUMB_PRESETS.light.height < THUMB_PRESETS.balanced.height);
  assert.ok(THUMB_PRESETS.balanced.height < THUMB_PRESETS.sharp.height);
  assert.ok(THUMB_PRESETS.light.webpQuality < THUMB_PRESETS.sharp.webpQuality);

  const jpeg = args({ format: 'jpeg', preset: 'sharp' });
  assert.ok(jpeg.includes('mjpeg'));
  // qscale mjpeg : bas = meilleur. Le cran net doit donc porter la valeur la PLUS basse.
  assert.equal(jpeg[jpeg.indexOf('-q:v') + 1], String(THUMB_PRESETS.sharp.jpegQscale));
  assert.ok(THUMB_PRESETS.sharp.jpegQscale < THUMB_PRESETS.light.jpegQscale);
});

test('covers current and legacy thumbnail variants so no cached file is left unnamed', () => {
  const variants = thumbKeyVariants();
  const suffixes = variants.map((v) => v.suffix);
  // 2 formats x 3 crans courants + 2 formats x 4 hauteurs x 3 qualités du modèle précédent.
  assert.equal(variants.length, 2 * 3 + 2 * 4 * 3);
  assert.equal(new Set(suffixes).size, variants.length, 'aucun doublon de suffixe');
  assert.ok(suffixes.includes(thumbKeySuffix(resolveThumbSettings({ format: 'webp', preset: 'balanced' }))));
  // Le suffixe du modèle précédent a une AUTRE forme : il ne se reconstruit pas via resolveThumbSettings.
  assert.ok(suffixes.includes('jpeg-480-82-v2'));
  assert.ok(variants.every((v) => v.ext === (v.suffix.startsWith('webp') ? 'webp' : 'jpg')));
  // Le chemin de purge passe par le suffixe, pas par des réglages : sinon les clés legacy sont perdues.
  assert.equal(thumbKeyFromSuffix('C:\\rush.mkv', 1.25, 'jpeg-480-82-v2').length, 32);
});

test('reserves thumbnail workers for visible cards while background warming runs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'thumbs.js'), 'utf8');
  assert.match(source, /THUMB_LOW_MAX/);
  assert.match(source, /thumbActive\s*<\s*THUMB_LOW_MAX/);
  assert.match(source, /thumbQHigh/);
});

test('reuses a persisted video proxy as the fastest thumbnail input', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-preview-test-'));
  t.after(() => {
    setCacheDir(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  setCacheDir(root);

  const source = path.join(root, 'rush.mkv');
  const proxy = path.join(getProxyDir(), 'cached.mp4');
  const webp = path.join(getProxyDir(), 'animated.webp');
  fs.writeFileSync(proxy, 'proxy');
  fs.writeFileSync(webp, 'webp');
  fs.writeFileSync(`${proxy}.nrproxy.json`, JSON.stringify({
    file: proxy,
    source,
    start: 10,
    duration: 4,
    container: 'mp4',
  }));
  fs.writeFileSync(`${webp}.nrproxy.json`, JSON.stringify({
    file: webp,
    source,
    start: 20,
    duration: 4,
    container: 'webp',
  }));

  assert.deepEqual(await proxyFrameSource(source, 12.25), { input: proxy, time: 2.25 });
  assert.equal(await proxyFrameSource(source, 14), null);
  assert.equal(await proxyFrameSource(source, 21), null);
});

test('purges only stale preview files for an edited timeline range', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-preview-purge-'));
  t.after(() => {
    setCacheDir(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  setCacheDir(root);
  fs.mkdirSync(getProxyDir(), { recursive: true });
  fs.mkdirSync(getThumbDir(), { recursive: true });
  const source = path.join(root, 'rush.mkv');
  const proxy = path.join(getProxyDir(), 'old.mp4');
  const meta = `${proxy}.nrproxy.json`;
  const time = 10 + Math.min(0.15, (10.1 - 10) * 0.4);
  const thumb = path.join(getThumbDir(), `${thumbKey(path.resolve(source), time, { format: 'jpeg', preset: 'balanced' })}.jpg`);
  fs.writeFileSync(proxy, 'proxy');
  fs.writeFileSync(meta, JSON.stringify({ file: proxy, source, start: 10, end: 10.1, duration: 0.6, container: 'mp4' }));
  fs.writeFileSync(thumb, 'thumb');
  const forgotten = [];
  const admin = createCacheAdmin({
    cacheIndex: { forget: (files) => forgotten.push(...files) },
    broadcast: () => {},
  });

  const result = await admin.purgePreviewRanges([{ path: source, start: 10, end: 10.1 }]);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(proxy), false);
  assert.equal(fs.existsSync(meta), false);
  assert.equal(fs.existsSync(thumb), false);
  assert.ok(forgotten.includes(proxy));
});

test('keeps NetsuLab thumbnail requests aligned with the shared cache contract', () => {
  const preview = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'upscale', 'UpscalePreview.tsx'), 'utf8');
  const sources = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'upscale', 'UpscaleSources.tsx'), 'utf8');
  const thumbs = fs.readFileSync(path.join(__dirname, '..', 'core', 'thumbs.js'), 'utf8');
  assert.match(preview, /warmResolveThumbs\(items\)/);
  assert.match(preview, /warmGenerateThumbs\(items\)/);
  assert.match(preview, /time:\s*thumbTime\(s\.start,\s*s\.end\)/);
  assert.match(preview, /<LazyThumb[^>]+at=\{s\.start\}[^>]+out=\{s\.end\}/);
  assert.match(sources, /<LazyThumb path=\{clip\.path\} at=\{THUMB_AUTO\}/);
  assert.match(sources, /<LazyThumb path=\{cut\.path\} at=\{cut\.in\} out=\{cut\.out\}/);
  assert.match(thumbs, /proxyFrameSource\(filePath, time\)/);
  assert.match(thumbs, /thumbArgs\(source\.input, source\.time, s\)/);
});

test('NetsuCut grid and player share the exact same proxy request and cache', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'useShotDetection.ts'), 'utf8');
  const playScene = source.slice(source.indexOf('async function playScene'), source.indexOf('async function detect'));
  assert.match(playScene, /await getProxy\(s, "high"\)/);
  assert.doesNotMatch(playScene, /height:\s*720/);
  assert.doesNotMatch(source, /videoProxyCache|audioVideoProxyCache|compatibleProxyCache/);
  assert.doesNotMatch(source, /requireVideo|requireAudio|codec\?:/);
  const cacheLoad = source.slice(source.indexOf('setSegments(segs);', source.indexOf('cachedScenes')), source.indexOf('setSegments(segs);', source.indexOf('cachedScenes')) + 500);
  assert.doesNotMatch(cacheLoad, /playScene\(segs\[0\]\)/);
  assert.doesNotMatch(source.slice(source.indexOf('async function detect'), source.indexOf('// Helpers recréés')), /playScene\(segs\[0\]\)/);
});

test('standalone proxy requests negotiate the codec supported by packaged WebView2', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coreClient.ts'), 'utf8');
  assert.match(client, /function standaloneProxyCodec\(/);
  assert.match(client, /video\/mp4;\s*codecs=\"hvc1\.1\.6\.L93\.B0\"/);
  assert.match(client, /canPlayType\(mime\)\s*===\s*"probably"/);
  assert.match(client, /MediaSource\.isTypeSupported\(mime\)/);
  const codecFunction = client.slice(client.indexOf('function standaloneProxyCodec'), client.indexOf('function requestParentFiles'));
  assert.match(codecFunction, /"hevc"\s*\|\s*"h264"/);
  assert.doesNotMatch(codecFunction, /vp8/);
  const proxyMethod = client.slice(client.indexOf('proxy: (opts)'), client.indexOf('proxyCancel:', client.indexOf('proxy: (opts)')));
  assert.match(proxyMethod, /isTauri\s*\?\s*standaloneProxyCodec/);
  assert.match(proxyMethod, /\{ codec \}/);
});

test('NetsuCut never creates a second fallback proxy for the right player', () => {
  const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'player', 'ScenePlayer.tsx'), 'utf8');
  const studio = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'CutStudio.tsx'), 'utf8');
  const detection = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'useShotDetection.ts'), 'utf8');
  assert.doesNotMatch(player, /onVideoUnavailable/);
  assert.doesNotMatch(studio, /onVideoUnavailable|playScene\(active,\s*"/s);
  assert.doesNotMatch(detection, /vp8|requireVideo|requireAudio/);
});

test('the shared proxy keeps the configured audio and starts the right player audibly', () => {
  const proxy = fs.readFileSync(path.join(__dirname, '..', 'core', 'proxy.js'), 'utf8');
  const studio = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'rushes', 'CutStudio.tsx'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'store', 'settings.ts'), 'utf8');
  assert.match(proxy, /const audio = settings\?\.audio\s*!==\s*false/);
  assert.doesNotMatch(proxy, /requireAudio|requireVideo/);
  assert.match(studio, /<ScenePlayer[^>]+defaultVolume=\{0\.2\}/);
  assert.match(settings, /if \(typeof localStorage === "undefined"\) return 0\.2/);
  assert.match(settings, /if \(raw == null\) return 0\.2/);
});

test('preview proxy settings expose HEVC, H.264 and shared WebM only', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'bridge.ts'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'previewSettings.ts'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings', 'PlaybackSettings.tsx'), 'utf8');
  assert.match(bridge, /type PreviewProxyFormat = "hevc" \| "h264" \| "webm"/);
  assert.doesNotMatch(bridge, /type PreviewProxyFormat = [^\n]*webp/);
  assert.match(settings, /proxy\.format === "webm" \|\| proxy\.format === "webp" \? "webm"/);
  assert.match(settings, /PREVIEW_SETTINGS_KEY = "nr\.preview-generation\.v2"/);
  assert.match(settings, /format: "h264"/);
  assert.match(panel, /WebM \(VP8\)/);
  assert.doesNotMatch(panel, /WebP animé/);
});

test('keeps CPU WebM work bounded while NVIDIA jobs can restore parallelism', () => {
  const proxy = fs.readFileSync(path.join(__dirname, '..', 'core', 'proxy.js'), 'utf8');
  assert.match(proxy, /res\s*&&\s*res\.ok\s*&&\s*res\.__hardware\s*&&\s*proxyMax\s*</);
  assert.match(proxy, /__hardware:\s*activeEncoder\.vendor\s*!==\s*'cpu'/);
});

test('offers thumbnails a single quality step instead of a height, and keeps the proxy profile control removed', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings', 'PlaybackSettings.tsx'), 'utf8');
  assert.doesNotMatch(source, /playback\.generation\.preset/);
  // Le cran REMPLACE la hauteur des miniatures : deux réglages pour une seule décision se contredisent.
  assert.match(source, /playback\.generation\.quality/);
  assert.match(source, /patchThumbnail\(\{ preset \}\)/);
  assert.doesNotMatch(source, /patchThumbnail\(\{ height/);
  assert.doesNotMatch(source, /thumbnailResolutionHint/);
  // Les aperçus vidéo gardent LEUR résolution : elle n'a rien à voir avec celle des miniatures.
  assert.match(source, /patchProxy\(\{ height \}\)/);
  assert.match(source, /hoverAudioAvailable/);
  assert.match(source, /disabled=\{!hoverAudioAvailable\}/);
});

test('never shows a stale native player surface after its React owner is gone', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'player', 'useNativePlayerSurface.ts'), 'utf8');
  assert.match(source, /const ownsSurface = \(\) => alive && lease === nativeSurfaceLease/);
  assert.match(source, /if \(!ownsSurface\(\)\) return;[\s\S]*return nativePlayer\.show\(\)/);
  assert.doesNotMatch(source, /\.then\(\(\) => nativePlayer\.show\(\)\)/);
});

test('sizes frame fields from their digits instead of clipping large frame numbers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'upscale', 'UpscalePlayer.tsx'), 'utf8');
  assert.match(source, /const fieldWidth = Math\.min\(16, Math\.max\(6, v\.length \+ 3\)\)/);
  assert.match(source, /style=\{\{ width: `\$\{fieldWidth\}ch` \}\}/);
  assert.doesNotMatch(source, /className="[^"]*\bw-(?:16|24)\b[^"]*"/);
});

test('binds the NetsuLab player lifecycle to the selected source', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'upscale', 'UpscalePreview.tsx'), 'utf8');
  const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'upscale', 'UpscalePlayer.tsx'), 'utf8');
  const emptyStart = source.indexOf('if (!active)');
  const activeStart = source.indexOf('const multi =', emptyStart);
  assert.ok(emptyStart >= 0 && activeStart > emptyStart);
  assert.doesNotMatch(source.slice(emptyStart, activeStart), /<UpscalePlayer/);
  assert.match(source, /<UpscalePlayer\s+key=\{activeKey\}/);
  assert.match(source, /if \(active\) return;[\s\S]*nativePlayer\.stop\(\)[\s\S]*nativePlayer\.hide\(\)/);
  assert.match(player, /if \(!playSignal \|\| !visible\) return;[\s\S]*if \(alive\) return nativePlayer\.play\(\)/);
});
