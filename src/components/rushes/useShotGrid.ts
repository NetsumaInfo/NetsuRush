// État commun d'une grille de plans hors derush (Collections, Timeline Live) : colonnes, lecture
// auto, plafond de lecture recalculé sur la zone visible, et cache proxy par (chemin|in|out). Mêmes
// invariants perf que CutStudio : aucune préchauffe spéculative, encode à la demande au survol/lecture.
//
// Densité et lecture auto viennent des réglages de NetsuCut (`cutCols`/`cutGridPlay`) : ces grilles
// affichent les MÊMES cartes que le Découpage, une densité par module se réglait trois fois.
import { useCallback, useEffect, useRef, useState } from "react";
import { nr, nextProxyToken } from "@/lib/bridge";
import { useApp } from "@/store";
import { forgetThumbs, getThumb, warmResolveThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";
import { autoplayCeiling, gridMetrics, resetPlaySlots, setMaxPlaying } from "./cutStudioShared";
import { previewSettingsFingerprint, PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";

// Un plan minimal pour la pré-génération de proxys (chemin + plage en secondes).
export type ProxyShot = { path: string; in: number; out: number };
// Un plan pour la préchauffe de vignettes (chemin + point d'entrée, frame si connue).
export type ThumbShot = { path: string; in: number; out?: number; inFrame?: number; fps?: number };
type GenerationState = { started: number; done: number; failed: number; total: number };

const WARM_THUMB_CHUNK = 8;
function waitForThumbIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => resolve(), { timeout: 1000 });
    else window.setTimeout(resolve, 80);
  });
}

/** `narrow` = vue étroite (panneau CEP, fenêtre épinglée) : plafonne la cellule pour garder
 *  plusieurs colonnes. La géométrie rendue est celle du Découpage (`gridMetrics`). */
export function useShotGrid({ narrow = false }: { narrow?: boolean } = {}) {
  const proxyCache = useRef<Map<string, string>>(new Map());
  // Carte + lecteur latéral peuvent demander le même plan dans le même rendu. Une seule promesse
  // possède alors l'encodage et tous les consommateurs reçoivent exactement le même résultat.
  const proxyPendingRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const warmVersionRef = useRef(0);
  const cols = useApp((s) => s.cutCols);
  const setColsStore = useApp((s) => s.setCutCols);
  // Enveloppe compatible `Dispatch<SetStateAction<number>>` : les appelants gardent `setCols((c) => c + 1)`.
  const setCols = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (v) => setColsStore(typeof v === "function" ? v(useApp.getState().cutCols) : v),
    [setColsStore],
  );
  // La lecture auto est un ÉTAT de vue amorcé par le réglage (comme CutStudio) : la basculer ici ne
  // change pas le défaut de démarrage des autres modules.
  const [gridPlay, setGridPlay] = useState(() => useApp.getState().cutGridPlay);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // Créneaux de lecture remis à zéro à l'entrée/sortie (évite un compteur faussé hérité).
  useEffect(() => { resetPlaySlots(); return () => { warmVersionRef.current++; resetPlaySlots(); }; }, []);
  useEffect(() => {
    const clear = () => proxyCache.current.clear();
    window.addEventListener(PREVIEW_SETTINGS_EVENT, clear);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, clear);
  }, []);

  // Largeur de la zone défilante → géométrie de la grille ET plafond de lecture, recalculés au
  // resize / changement de densité (mêmes formules que le Découpage).
  const [gridW, setGridW] = useState(0);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const recompute = () => {
      const cw = el.clientWidth, ch = el.clientHeight;
      if (!cw || !ch) return;
      setGridW(cw);
      const ceiling = autoplayCeiling(cw, ch, cols, narrow);
      if (ceiling) setMaxPlaying(ceiling);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols, narrow]);
  const { cell, actualCols } = gridMetrics(gridW, cols, narrow);

  const key = (path: string, start: number, end: number, requireVideo = false) => `${path}|${start.toFixed(3)}|${end.toFixed(3)}|${requireVideo ? "video" : "grid"}|${previewSettingsFingerprint()}`;

  // Génère/récupère le proxy d'un plan (cache renderer par chemin+plage). Hauteur ignorée dans la
  // clé : stable tant que les colonnes ne changent pas (palier serveur quasi identique).
  async function getProxy(path: string, start: number, end: number, priority: "high" | "low" = "high", height?: number, token?: number, requireVideo = false): Promise<string | null> {
    const k = key(path, start, end, requireVideo);
    const c = proxyCache.current.get(k);
    if (c) return c;
    const pending = proxyPendingRef.current.get(k);
    if (pending) return pending;
    const request = nr.proxy({ input: path, start, end, priority, height, token, requireVideo })
      .then((r) => {
        if (!r.ok || !r.path) return null;
        const u = nr.mediaUrl(r.path);
        proxyCache.current.set(k, u);
        return u;
      })
      .finally(() => proxyPendingRef.current.delete(k));
    proxyPendingRef.current.set(k, request);
    return request;
  }
  const bust = (path: string, start: number, end: number) => proxyCache.current.delete(key(path, start, end));

  // Réutilise d'abord le cache existant, puis génère les manquantes par PETITS lots pendant les creux.
  // Un nouvel appel/remount annule logiquement l'ancien parcours : aucun poll ni fan-out global.
  function warmThumbs(shots: ThumbShot[]) {
    if (!shots.length) return;
    const version = ++warmVersionRef.current;
    void (async () => {
      const items = shots.map((s) => ({ path: s.path, time: thumbTime(s.in, s.out) }));
      await warmResolveThumbs(items);
      if (warmVersionRef.current !== version) return;
      const missing = shots.filter((s) => !getThumb(s.path, thumbTime(s.in, s.out)));
      const byFile = new Map<string, ThumbShot[]>();
      for (const s of missing) {
        const list = byFile.get(s.path);
        if (list) list.push(s); else byFile.set(s.path, [s]);
      }
      for (const [path, list] of byFile) {
        for (let offset = 0; offset < list.length; offset += WARM_THUMB_CHUNK) {
          await waitForThumbIdle();
          if (warmVersionRef.current !== version) return;
          const chunk = list.slice(offset, offset + WARM_THUMB_CHUNK);
          await nr.thumbsBatch(path, chunk.map((s) => {
            const time = thumbTime(s.in, s.out);
            return { time, frame: s.fps ? Math.round(time * s.fps) : (s.inFrame ?? 0) };
          })).catch(() => {});
          if (warmVersionRef.current !== version) return;
          await warmResolveThumbs(chunk.map((s) => ({ path: s.path, time: thumbTime(s.in, s.out) })));
        }
      }
    })();
  }

  // Version « bouton » : pool BORNÉ (8 ouvriers) + ARRÊT, comme generateProxies. CPU (thumbGate),
  // indépendant de la génération proxy (GPU/proxyGate) → les deux tournent EN MÊME TEMPS. Pas de
  // thumbsBatch ici : un gros batch n'est pas annulable et son verrou global écrase le multi-fichier ;
  // ici chaque plan = un nr.thumbnail (caché disque/RAM), l'arrêt lève thumbsAbort → plus de fetch.
  const [thumbsGen, setThumbsGen] = useState<GenerationState | null>(null);
  const thumbsAbortRef = useRef(false);
  const thumbsRunRef = useRef<Promise<void> | null>(null);
  async function generateThumbs(shots: ThumbShot[]) {
    if (thumbsRunRef.current) { thumbsAbortRef.current = true; return; }   // re-clic = ARRÊT
    if (!shots.length) return;
    thumbsAbortRef.current = false;
    const run = (async () => {
      let started = 0, done = 0, failed = 0, idx = 0;
      const publish = () => setThumbsGen({ started, done, failed, total: shots.length });
      publish();
      const worker = async () => {
        while (idx < shots.length && !thumbsAbortRef.current) {
          const s = shots[idx++];
          started++; publish();
          try {
            const result = await nr.thumbnail(s.path, thumbTime(s.in, s.out));
            if (typeof result !== "string") failed++;
          } catch { failed++; }
          done++; publish();
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      if (!thumbsAbortRef.current) {
        await warmResolveThumbs(shots.map((s) => ({ path: s.path, time: thumbTime(s.in, s.out) })));
      }
      if (failed) console.warn(`[miniatures] ${failed}/${done} générations échouées`);
    })();
    thumbsRunRef.current = run;
    try { await run; } finally {
      if (thumbsRunRef.current === run) thumbsRunRef.current = null;
      setThumbsGen(null);
      thumbsAbortRef.current = false;
    }
  }

  // Pré-génère les proxys d'aperçu de TOUS les plans passés (ou de la sélection) à la MÊME hauteur
  // que la grille → la lecture auto réutilise les fichiers (instantané). Priorité 'low' : la file core
  // cède toujours au survol/plan actif. Pool BORNÉ (6 ouvriers) + abort : « Arrêter » lève genAbort
  // (aucun nouveau fetch) et proxyCancelMany tue les ≤6 encodes en vol. Cf. CutStudio.generateProxies.
  const [proxyGen, setProxyGen] = useState<GenerationState | null>(null);
  const genAbortRef = useRef(false);
  const genTokensRef = useRef<number[]>([]);
  const proxyRunRef = useRef<Promise<void> | null>(null);

  async function generateProxies(list: ProxyShot[]) {
    if (proxyRunRef.current) {   // déjà en cours → sert d'ARRÊT
      genAbortRef.current = true;
      nr.proxyCancelMany(genTokensRef.current);
      return;
    }
    if (!list.length) return;
    // hauteur de cellule = largeur carte × 9/16 × DPR (cf. SceneCard) → même palier que la grille.
    const el = gridScrollRef.current;
    let height: number | undefined;
    if (el?.clientWidth) {
      const cardW = gridMetrics(el.clientWidth, cols, narrow).cell;
      height = Math.round(((cardW * 9) / 16) * (window.devicePixelRatio || 1));
    }
    genAbortRef.current = false;
    genTokensRef.current = [];
    const run = (async () => {
      let started = 0, done = 0, failed = 0, idx = 0;
      const publish = () => setProxyGen({ started, done, failed, total: list.length });
      publish();
      const worker = async () => {
        while (idx < list.length && !genAbortRef.current) {
          const s = list[idx++];
          const token = nextProxyToken();
          genTokensRef.current.push(token);
          started++; publish();
          try { if (!await getProxy(s.path, s.in, s.out, "low", height, token)) failed++; } catch { failed++; }
          done++; publish();
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (failed) console.warn(`[proxies] ${failed}/${done} générations échouées`);
    })();
    proxyRunRef.current = run;
    try { await run; } finally {
      if (proxyRunRef.current === run) proxyRunRef.current = null;
      setProxyGen(null);
      genAbortRef.current = false;
    }
  }

  async function cancelGeneration() {
    thumbsAbortRef.current = true;
    genAbortRef.current = true;
    nr.proxyCancelMany(genTokensRef.current);
    await Promise.allSettled([thumbsRunRef.current, proxyRunRef.current].filter((run): run is Promise<void> => !!run));
  }

  // Appelée uniquement quand l'empreinte complète d'une timeline change. Purge d'abord les anciennes
  // plages sur disque et en RAM ; les nouvelles générations peuvent ensuite repartir sur un état net.
  async function invalidatePreviewRanges(list: ProxyShot[]) {
    if (!list.length) return;
    await cancelGeneration();
    const prefixes = list.map((s) => `${s.path}|${s.in.toFixed(3)}|${s.out.toFixed(3)}|`);
    for (const cachedKey of proxyCache.current.keys()) {
      if (prefixes.some((prefix) => cachedKey.startsWith(prefix))) proxyCache.current.delete(cachedKey);
    }
    forgetThumbs(list.flatMap((s) => {
      const precise = thumbTime(s.in, s.out);
      const legacy = thumbTime(s.in);
      return precise === legacy ? [{ path: s.path, time: precise }] : [{ path: s.path, time: precise }, { path: s.path, time: legacy }];
    }));
    await nr.cache?.purgePreviewRanges(list.map((s) => ({ path: s.path, start: s.in, end: s.out })));
    genAbortRef.current = false;
    genTokensRef.current = [];
  }

  return { cols, setCols, cell, actualCols, gridPlay, setGridPlay, gridScrollRef, getProxy, bust, warmThumbs, proxyGen, generateProxies, thumbsGen, generateThumbs, cancelGeneration, invalidatePreviewRanges };
}
