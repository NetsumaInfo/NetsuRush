// @ts-check
// Orchestration de l'export After Effects : lit la timeline Resolve, prépare les médias, mappe en
// calques AE (frame-math), écrit le .jsx et lance AfterFX.exe. Détail dans core/ae/*.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { sanitizeName: sanitize } = require('./utils');
const { isImageRunning } = require('./processList');
const { AUDIO_PRODUCES, isImagePath } = require('./ae/codecs');
const { resolveInstalledCodec, gpuFamily } = require('./adaptiveCodec');
const { readTimelineEdit } = require('./ae/timelineRead');
const { prepareMedia } = require('./ae/prepareMedia');
const { upscaleStep, aeEncoding } = require('./ae/upscaleStep');
const { codecExt } = require('./utils');
const { genAeScript } = require('./ae/jsx');
const { t } = require('./i18n');

function findAfterFx(CONFIG) {
  if (CONFIG && CONFIG.afterFx && fs.existsSync(CONFIG.afterFx)) return CONFIG.afterFx;
  const roots = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Adobe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Adobe'),
  ];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_) { continue; }
    for (const e of entries) {
      if (!/After Effects/i.test(e)) continue;
      const exe = path.join(root, e, 'Support Files', 'AfterFX.exe');
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  found.sort().reverse();
  return found[0] || null;
}

function launchAe(afterFx, jsxPath, logPath) {
  try {
    const child = spawn(afterFx, ['-r', jsxPath], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => { try { fs.appendFileSync(logPath, 'SPAWN ERROR: ' + e + '\n'); } catch (_) {} });
    child.unref();
    return true;
  } catch (e) {
    try { fs.appendFileSync(logPath, 'SPAWN THROW: ' + e + '\n'); } catch (_) {}
    return false;
  }
}

const isAeRunning = () => isImageRunning('AfterFX.exe');

/**
 * Transform NEUTRE d'un plan dont le cadrage est déjà cuit dans le fichier : le média arrive à la
 * taille de la timeline, donc l'ajustement d'`applyXf` vaut 1 et le calque se pose plein cadre.
 */
const BAKED_XF = {
  zoomX: 1, zoomY: 1, pan: 0, tilt: 0, rot: 0, anchorX: 0, anchorY: 0, opacity: 100,
  cropL: 0, cropR: 0, cropT: 0, cropB: 0, flipX: 0, flipY: 0,
};

/** Fin du journal du script (le .jsx n'ouvre jamais de modale : il écrit tout ici). */
function tailLog(logPath, lines = 12) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n') || undefined;
  } catch (_) {
    return undefined; // journal absent = script sans rien à dire
  }
}

function createAeExport(deps) {
  const { getResolve, CONFIG } = deps;

  /** Le panneau CEP d'After Effects est-il joignable ? (livraison dans le projet OUVERT). */
  async function panelReachable() {
    if (typeof deps.runAeScript !== 'function' || typeof deps.aePanelConnected !== 'function') return false;
    try { return !!(await deps.aePanelConnected()); } catch (e) {
      console.warn('[ae] statut du panneau illisible :', e && e.message);
      return false;
    }
  }

  async function aeExport(event, opts = {}) {
    try {
      const {
        timelineName = null,
        compName = null,
        videoMode = 'copy',
        codec: requestedCodec = 'prores_422',
        audio = 'copy',
        abr = 192,
        handleSec = 0,
        precomp = false,
        precompNaming = 'file',
        precompTarget = 'video',
        folders = false,
        videoContainer = null,
        audioContainer = null,
        transformMode = 'none',   // none | ae | bake
        nestedMode = 'flatten',   // flatten = contenu | comp = timeline en précompo | render
        audioRenderFmt = 'wav',   // format du rendu si timeline imbriquée audio seule
        deliver = 'auto',         // auto = panneau CEP si AE est joignable, sinon lancement | panel | launch
      } = opts;

      const bake = transformMode === 'bake';
      const transforms = transformMode !== 'none';
      // L'upscale REMPLACE les pixels : ni la copie ni le réencapsulage ne peuvent le faire, donc
      // l'option impose la production d'un fichier — comme à l'archivage d'une collection.
      const grow = !!(opts.upscale && opts.upscale.enabled);
      // Le bake cuit la vitesse dans le fichier : il IMPOSE lui aussi le réencode, seul moyen d'une
      // coupe exacte à la frame (`-c copy` ne coupe que sur keyframe, cf. limite ffmpeg).
      const vMode = (bake || grow) ? 'reencode' : videoMode;
      const family = gpuFamily(String(requestedCodec));
      const adaptive = await resolveInstalledCodec(
        String(requestedCodec), family === 'hevc' ? 'main10' : family === 'h264' ? 'high' : null,
        family === 'hevc' ? 10 : 8,
      );
      // Resolve reçoit son id H264/H265 générique ; seuls les réencodes ffmpeg reçoivent le nom
      // matériel concret (NVENC/QSV/AMF). Les codecs montage restent inchangés.
      const resolveCodec = family ? adaptive.fallbackCodec : String(requestedCodec);
      const mediaCodec = adaptive.codec;

      const resolve = await getResolve();
      if (!resolve) return { ok: false, error: t('resolveUnavailable') };

      const outDir = opts.outDir || null;
      if (outDir) { try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {} }

      // Images clés lues seulement quand les transforms voyagent : sans elles l'export XML de
      // Resolve serait un aller-retour disque pour rien.
      const edit = await readTimelineEdit(resolve, timelineName, { nestedMode, outDir, codec: resolveCodec, audio, audioRenderFmt, event, animation: transforms, bakeTransforms: bake });
      if (!edit.ok) return edit;
      if (!edit.items.length) {
        return { ok: false, error: t('noUsableClips'), missing: edit.missing };
      }

      // Fichiers produits sur disque (dossier obligatoire) : réencode/remux, timeline imbriquée
      // rendue, ou audio réencodé. `nestedMode: 'render'` compte aussi — Resolve écrit alors un
      // fichier par timeline imbriquée.
      const audioProduces = AUDIO_PRODUCES.has(audio) && edit.items.some((c) => c.kind === 'audio');
      if ((vMode !== 'copy' || nestedMode === 'render' || audioProduces) && !outDir) {
        return { ok: false, error: t('chooseOutputFolder') };
      }

      // Conteneurs rabattus faute de pouvoir porter les flux (ProRes en MP4, PCM en M4A) : la
      // préparation les remplit, le résultat les dit — un conteneur changé en silence livrerait
      // autre chose que ce qui a été demandé.
      const containerNotes = [];
      // Upscale : moteur de NetsuLab, réglages du panneau, exécutants liés à CET événement pour
      // que la progression parte sur le même canal que le reste de l'export.
      const upscale = upscaleStep(opts.upscale, {
        runUpscale: deps.runUpscale ? (args) => deps.runUpscale(event, args) : undefined,
        runTurbo: deps.runTurbo ? (args) => deps.runTurbo(event, args) : undefined,
      }, aeEncoding(requestedCodec, audio, abr), codecExt(mediaCodec));
      const prepared = await prepareMedia(deps, event, edit, { videoMode: vMode, codec: mediaCodec, audio, abr, handleSec, outDir, videoContainer, audioContainer, bake, upscale, fps: edit.fps, compW: edit.width, compH: edit.height, notes: containerNotes });

      const groupsById = {};
      for (const g of (edit.groups || [])) groupsById[g.id] = g;

      const layers = prepared.map((c) => {
        // Réf temporelle : calque groupé → temps de la précompo imbriquée ; sinon timeline parente.
        const g = c.group ? groupsById[c.group] : null;
        const refStart = g ? g.nestedStart : edit.startFrame;
        const refFps = g ? g.fps : edit.fps;
        const posSec = (c.tlStart - refStart) / refFps;
        const occSec = (c.tlEnd - c.tlStart) / refFps;   // durée d'occupation (vérité)
        // Cadrage déjà cuit dans le fichier (mode « Réencodé ») : le calque ne doit plus RIEN
        // reposer, sinon zoom et décalage s'appliquent une seconde fois. Seule l'opacité survit —
        // elle ne se cuit pas dans un fichier sans transparence.
        const xf = !transforms ? null
          : c.xfBaked ? { ...BAKED_XF, opacity: (c.xf && c.xf.opacity) != null ? c.xf.opacity : 100 }
          : c.xf;
        // Les images clés sont datées en frames DEPUIS LE DÉBUT DU PLAN, sur la base de temps de la
        // comp qui l'accueille : le calque doit emporter son origine et sa cadence pour les poser.
        const anim = transforms ? c.anim || null : null;
        const keys = anim ? { anim, keyStart: posSec, keyFps: refFps } : null;
        // Image = vrai still OU freeze (1 frame extraite en .png) → AE la tient sur toute l'occupation.
        const image = isImagePath(c.file || c.path) || !!c.freezeStill;
        const group = c.group || undefined;

        // bake : fichier déjà à la vitesse timeline → pose 1:1, pas de remap.
        if (c.baked) {
          return { file: c.file, name: c.name || undefined, kind: c.kind, xf, xfBaked: !!c.xfBaked,
            ...keys, occSec, image, group,
            startTime: posSec, inPoint: posSec, outPoint: posSec + (c.bakedDur || occSec) };
        }

        const inSrcSec = (c.fileInFrame || 0) / c.fpsClip;
        const srcDurSec = (c.srcOut - c.srcIn + 1) / c.fpsClip;
        // Time-remap AE AUTOMATIQUE pour reverse (Resolve : ssf>sef) et retime (durée source ≠ occupation).
        // Reverse = on lit le segment à l'envers (remapIn/remapOut inversés). Jamais sur une image/freeze.
        const speedDiff = Math.abs(srcDurSec - occSec) > (1.5 / refFps);
        const retime = c.kind === 'video' && !image
          && (c.reverse || c.retimed || (transformMode === 'ae' && speedDiff));
        if (retime) {
          const fIn = (c.fileInFrame || 0) / c.fpsClip;
          const fOut = ((c.fileInFrame || 0) + (c.srcOut - c.srcIn + 1)) / c.fpsClip;
          return { file: c.file, name: c.name || undefined, kind: c.kind, xf, ...keys, occSec, image, group,
            retime: true, posSec, remapIn: c.reverse ? fOut : fIn, remapOut: c.reverse ? fIn : fOut,
            outPoint: posSec + occSec };
        }
        // outPoint calé sur occSec (pas sur la durée source) → stills/audio aux durées aberrantes OK.
        return {
          file: c.file,
          name: c.name || undefined,
          kind: c.kind,
          xf,
          ...keys,
          occSec,
          image,
          group,
          startTime: posSec - inSrcSec,
          inPoint: posSec,
          outPoint: posSec + occSec,
        };
      });

      // Placement de chaque précompo imbriquée dans la comp principale + durée propre.
      const groups = (edit.groups || []).map((g) => {
        const inPoint = (g.parentTlStart - edit.startFrame) / edit.fps;
        const outPoint = (g.parentTlEnd - edit.startFrame) / edit.fps;
        const offset = (g.winStart - g.nestedStart) / g.fps;   // 1re frame visible dans la précompo
        const dur = Math.max(0.04,
          layers.filter((l) => l.group === g.id).reduce((m, l) => Math.max(m, l.outPoint || 0), 0),
          outPoint - inPoint + offset);
        return { id: g.id, name: g.name, w: g.w, h: g.h, fps: g.fps, dur,
          place: { startTime: inPoint - offset, inPoint, outPoint } };
      });

      // Durée comp principale : ignore les calques groupés (placés via leur précompo).
      const lastOut = layers.reduce((m, l) => l.group ? m : Math.max(m, l.outPoint || 0), 0);
      const groupsOut = groups.reduce((m, g) => Math.max(m, g.place.outPoint || 0), 0);
      const tlDur = (edit.endFrame - edit.startFrame) / edit.fps;
      const durSec = Math.max(0.04, lastOut, groupsOut, tlDur);
      const name = (compName && String(compName).trim()) || edit.timeline || 'NetsuRush';
      const payload = {
        comp: { name, w: edit.width, h: edit.height, fps: edit.fps, dur: durSec },
        layers,
        groups,
        precomp: !!precomp,
        precompNaming,
        precompTarget,
        folders: !!folders,
        transforms,
      };

      // AfterFX.exe -r casse sur un espace dans le chemin → dossier + nom sans espace ni accent.
      const jsxDir = path.join(process.env['PUBLIC'] || os.tmpdir(), 'netsurush-ae');
      try { fs.mkdirSync(jsxDir, { recursive: true }); } catch (_) {}
      const fileBase = (sanitize(name)
        .replace(/[^\x20-\x7E]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_').replace(/^_|_$/g, '') || 'export');
      const jsxPath = path.join(jsxDir, `${fileBase}.jsx`);
      const logPath = path.join(jsxDir, `${fileBase}.log`);
      try { fs.writeFileSync(logPath, ''); } catch (_) {}
      fs.writeFileSync(jsxPath, genAeScript(payload, logPath), 'utf8');

      const done = { comp: name, clips: layers.length, outDir, script: jsxPath, missing: edit.missing,
        animated: edit.animated || 0, containerFallbacks: containerNotes.length };

      // Livraison par le panneau CEP : le script est déroulé dans l'After Effects DÉJÀ ouvert.
      // « AfterFX.exe -r » suppose au contraire qu'AE tourne avec un projet prêt — sinon le script
      // part avant le projet et l'import se perd : c'est la panne historique de cet export.
      if (deliver !== 'launch' && await panelReachable()) {
        const sent = await deps.runAeScript(event, jsxPath);
        if (sent && sent.ok) {
          return { ok: true, ...done, aeRunning: true, delivered: 'panel', log: tailLog(logPath) };
        }
        const reason = (sent && (sent.error || sent.errorCode)) || t('panelTimeout');
        if (deliver === 'panel') return { ok: false, error: reason, ...done, delivered: 'panel' };
        console.warn('[ae] livraison par le panneau impossible, repli sur le lancement :', reason);
      }

      const afterFx = findAfterFx(CONFIG);
      if (!afterFx) return { ok: false, error: t('aeUnavailable'), ...done };
      const aeRunning = await isAeRunning();
      const launched = launchAe(afterFx, jsxPath, logPath);
      return {
        ok: launched, ...done, aeRunning, delivered: 'launch',
        error: launched ? undefined : t('aeLaunchFailed'),
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  return { aeExport };
}

module.exports = { createAeExport };
