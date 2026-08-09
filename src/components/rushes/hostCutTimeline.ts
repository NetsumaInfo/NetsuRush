// Découpe d'une timeline sur hôte ADOBE (Premiere / After Effects).
//
// Resolve a un flux NATIF côté core (`core/timeline.js` : lecture de la timeline par le pont Python,
// FCPXML, through-edits, remplacement de l'originale). Adobe n'a pas d'équivalent — et n'en a pas
// besoin : (1) les plans montés sont DÉJÀ dans le snapshot poussé par le panneau CEP, (2) la
// détection de plans travaille sur des FICHIERS, donc elle est agnostique de l'hôte, (3) le montage
// repart par le job du panneau (`hostBuildTimeline`). Tout tient donc côté renderer, sans canal neuf.
//
// Le résultat a la MÊME forme que `nr.analyzeTimelineCut` (CutAnalysis) : l'éditeur de coupes
// (CutEditor) et la vue de découpe sont réutilisés tels quels.
import i18n from "@/i18n";
import {
  nr,
  type CutAnalysis, type CutClip, type CutShot,
  type DetectModel, type DetectOptions, type TimelineCut,
} from "@/lib/bridge";
import { hostBuildTimeline } from "@/lib/host";
import { createSmoothProgress } from "@/lib/smoothProgress";
import type { HostId } from "@/store/types";

// Part de détection dans la progression totale de l'analyse (le reste = calcul des coupes), comme
// le flux Resolve : 0..90 détection, 90..100 analyse.
const DETECT_SHARE = 90;

export interface HostCutProgress {
  file: string;
  done: number;
  total: number;
  pct: number;
  phase: "detect" | "analyze";
}

/** fps décimal → rationnel exact. Les cadences NTSC sont des 1000/1001, pas des décimaux ronds. */
function fpsRational(fps: number): { num: number; den: number } {
  const ntsc = [24, 30, 60, 120];
  for (const base of ntsc) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.01) return { num: base * 1000, den: 1001 };
  }
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  return { num: Math.round(fps * 1000), den: 1000 };
}

/** Plans SOURCE d'un rush depuis les scènes détectées : bornes monotones, jamais hors média. */
function shotsFromScenes(
  scenes: { start: number; end: number; startFrame?: number; endFrame?: number }[],
  fps: number,
  detFrames: number,
): CutShot[] {
  const maxExcl = detFrames > 0 ? detFrames : Number.MAX_SAFE_INTEGER;
  let previous = -1;
  const starts = scenes.map((scene) => {
    const raw = scene.startFrame != null ? scene.startFrame : Math.round(scene.start * fps);
    const value = Math.max(previous + 1, Math.min(maxExcl - 1, Math.max(0, raw)));
    previous = value;
    return value;
  });
  const shots: CutShot[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const startFrame = starts[i];
    if (startFrame >= maxExcl) break;
    const next = starts[i + 1];
    const scene = scenes[i];
    // `endFrame` est INCLUSIF (convention NetsuRush) → +1 pour obtenir la borne exclusive.
    const ownEnd = (scene.endFrame != null ? scene.endFrame : Math.round(scene.end * fps) - 1) + 1;
    const endExcl = Math.min(maxExcl, Math.max(startFrame + 1, next != null && next > startFrame ? next : ownEnd));
    shots.push({ startFrame, frames: endExcl - startFrame });
  }
  return shots;
}

/** Rushs DISTINCTS d'une séquence/comp, dans l'ordre où ils apparaissent sur la timeline. */
function timelineSources(cuts: TimelineCut[]): { path: string; name: string; fps: number }[] {
  const seen = new Set<string>();
  const sources: { path: string; name: string; fps: number }[] = [];
  for (const cut of cuts) {
    const key = cut.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ path: cut.path, name: cut.name, fps: cut.fps });
  }
  return sources;
}

export interface HostCutAnalyzeOpts {
  /** Plans montés de la séquence/comp (snapshot CEP, cf. `hostTimelineCuts`). */
  cuts: TimelineCut[];
  timelineName: string;
  model: DetectModel;
  threshold: number;
  detectionOptions: DetectOptions;
  onProgress?: (p: HostCutProgress) => void;
}

/**
 * Détecte les plans de tous les rushs d'une séquence Premiere / comp AE et rend la structure de
 * coupe éditable — sans rien monter. Même contrat que `nr.analyzeTimelineCut` côté Resolve.
 */
export async function analyzeHostTimelineCut(opts: HostCutAnalyzeOpts): Promise<CutAnalysis> {
  const { cuts, timelineName, model, threshold, detectionOptions, onProgress } = opts;
  const sources = timelineSources(cuts);
  if (!sources.length) return { ok: false, clips: [], error: i18n.t("derush:cutTimeline.noMedia") };

  const total = sources.length;
  const report = (index: number, localPct: number, phase: HostCutProgress["phase"], file: string) => {
    const bounded = Math.max(0, Math.min(100, localPct));
    const pct = phase === "analyze"
      ? DETECT_SHARE + Math.round((bounded * (100 - DETECT_SHARE)) / 100)
      : Math.round(((index + bounded / 100) / total) * DETECT_SHARE);
    onProgress?.({ file, done: index, total, pct, phase });
  };

  const clips: CutClip[] = [];
  for (let i = 0; i < total; i++) {
    const source = sources[i];
    report(i, 0, "detect", source.name);
    let result = await nr.cachedScenes(source.path, model, threshold, detectionOptions);
    if (!result?.cached || !result.scenes?.length) {
      // La progression de detect.py porte le chemin du fichier → on ne suit que le rush en cours.
      // Lissée : la détection est muette pendant le chargement du modèle et la lecture full-vidéo.
      const track = createSmoothProgress((pct) => report(i, pct, "detect", source.name));
      const off = nr.onScenesProgress((p) => { if (!p.path || p.path === source.path) track.to(p.pct); });
      try {
        result = await nr.detectScenes(source.path, threshold, model, detectionOptions);
      } finally {
        off();
        track.stop();
      }
    }
    const scenes = result?.scenes ?? [];
    if (!scenes.length) continue;

    const fps = Number(result?.fps) || source.fps || 24;
    const detFrames = Number(result?.frames) || 0;
    const shots = shotsFromScenes(scenes, fps, detFrames);
    if (!shots.length) continue;

    const info = await nr.probe(source.path).catch(() => null);
    const last = shots[shots.length - 1];
    clips.push({
      // `src` (file:// URL) ne sert qu'au FCPXML de Resolve ; côté Adobe le montage part de `path`.
      src: "", path: source.path, name: source.name,
      fps: fpsRational(fps), fpsNum: fps,
      totalFrames: detFrames || last.startFrame + last.frames,
      w: info?.width ?? 0, h: info?.height ?? 0,
      shots,
    });
    report(i, 100, "detect", source.name);
  }

  report(total, 100, "analyze", "");
  if (!clips.length) return { ok: false, clips: [], error: i18n.t("derush:cutTimeline.noShots") };
  return {
    ok: true,
    source: timelineName,
    base: i18n.t("derush:cutTimeline.defaultName", { name: timelineName }),
    clips,
    shots: clips.reduce((sum, clip) => sum + clip.shots.length, 0),
  };
}

/**
 * Monte la structure de coupe dans l'hôte Adobe : une séquence/comp NEUVE dont les plans sont les
 * plans détectés, bout-à-bout. Pas de mode « remplacer » : aucune API Premiere/AE ne supprime et
 * renomme une séquence de façon fiable, alors que Resolve le fait (cf. `buildCutTimeline`).
 */
export async function buildHostCutTimeline(
  host: HostId,
  opts: { name?: string; source?: string; clips: CutClip[] },
): Promise<{ ok: boolean; timeline?: string; shots?: number; error?: string }> {
  const segments = opts.clips.flatMap((clip) => {
    const fps = clip.fpsNum || (clip.fps.den ? clip.fps.num / clip.fps.den : 24) || 24;
    return clip.shots.map((shot) => ({
      in: shot.startFrame / fps,
      out: (shot.startFrame + shot.frames) / fps,
      inFrame: shot.startFrame,
      outFrame: shot.startFrame + shot.frames - 1,   // borne INCLUSIVE, comme partout dans NetsuRush
      path: clip.path,
    }));
  });
  if (!segments.length) return { ok: false, error: i18n.t("derush:shared.noShots") };

  const first = opts.clips[0];
  const r = await hostBuildTimeline(host, {
    name: opts.name || i18n.t("derush:cutTimeline.defaultName", { name: opts.source ?? "" }),
    input: first.path,
    mode: "new",
    fps: first.fpsNum,
    segments,
  });
  return { ok: r.ok, timeline: r.timeline, shots: r.count, error: r.error };
}
