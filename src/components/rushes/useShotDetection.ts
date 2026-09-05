import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { nr, type MediaInfo, type DetectModel, type CutSpan, type CutEdits } from "@/lib/bridge";
import { useApp } from "@/store";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { detectionOptionsFor, detectionOptionsKey, detectionThreshold } from "@/lib/detection";
import { createSmoothProgress } from "@/lib/smoothProgress";
import { toast } from "@/components/ui/toast";
import {
  nextSegId, modelLabel, PRESETS, MODELS, type Segment,
} from "./cutStudioShared";
import { usePreviewCache, type GenerationState, type PreviewSource } from "./previewCache";

// Réapplique les fusions persistées à une liste de plans FRAÎCHEMENT détectés/rechargés. Recalage
// par CHEVAUCHEMENT de frames (les bornes du détecteur peuvent bouger d'une passe à l'autre) : tout
// plan qui chevauche l'étendue d'une fusion est absorbé, l'union s'aligne sur les vraies bornes des
// plans absorbés. Frames = vérité si dispo, sinon secondes. Entrée triée par `in` (le détecteur rend
// déjà trié) → la sortie le reste.
function applyStoredMerges(segs: Segment[], merges: CutSpan[]): Segment[] {
  if (!merges.length || segs.length < 2) return segs;
  const useF = segs.every((s) => s.inFrame != null && s.outFrame != null);
  const bounds = (s: Segment): [number, number] => (useF ? [s.inFrame!, s.outFrame!] : [s.in, s.out]);
  let result = segs.slice();
  for (const m of merges) {
    const lo = useF && m.inFrame != null ? m.inFrame : m.in;
    const hi = useF && m.outFrame != null ? m.outFrame : m.out;
    const inside = result.filter((s) => { const [a, b] = bounds(s); return b > lo && a < hi; });
    if (inside.length < 2) continue;                       // fusion obsolète (0/1 plan) → ignorée
    inside.sort((a, b) => a.in - b.in);
    const first = inside[0], last = inside[inside.length - 1];
    const merged: Segment = { id: nextSegId(), in: first.in, out: last.out, inFrame: first.inFrame, outFrame: last.outFrame, path: first.path };
    const drop = new Set(inside);
    result = result.filter((s) => !drop.has(s));
    result.push(merged);
    result.sort((a, b) => a.in - b.in);
  }
  return result;
}

// Retire les plans écartés d'une liste FRAÎCHEMENT détectée/rechargée. Recalage par le CENTRE du
// plan (et non par chevauchement comme les fusions) : d'une passe à l'autre les bornes bougent, mais
// un plan dont le milieu tombe dans la plage retirée reste bien celui que l'utilisateur a écarté —
// alors qu'un test de chevauchement emporterait aussi les voisins qui la mordent.
// Appliqué APRÈS applyStoredMerges : les fusions remodèlent les plans, les retraits en éliminent.
function applyStoredRemovals(segs: Segment[], removed: CutSpan[]): Segment[] {
  if (!removed.length || !segs.length) return segs;
  const useF = segs.every((s) => s.inFrame != null && s.outFrame != null);
  const mid = (s: Segment): number => (useF ? (s.inFrame! + s.outFrame!) / 2 : (s.in + s.out) / 2);
  return segs.filter((s) => {
    const c = mid(s);
    return !removed.some((r) => {
      const lo = useF && r.inFrame != null ? r.inFrame : r.in;
      const hi = useF && r.outFrame != null ? r.outFrame : r.out;
      return c >= lo && c <= hi;
    });
  });
}

// Rejoue l'intégralité des édits gardés sur une découpe fraîche. Déterministe : c'est ce qui permet
// à undo/redo de simplement remonter la pile puis relire le cache, sans réparer les plans à la main.
function applyEdits(segs: Segment[], edits: CutEdits): Segment[] {
  return applyStoredRemovals(applyStoredMerges(segs, edits.merges), edits.removed);
}

const EMPTY_EDITS: CutEdits = { merges: [], removed: [] };

// Les édits appartiennent au couple (rush, modèle) : dans un flux, chaque rush a donc les siens.
// L'historique, lui, est celui du FLUX — un Ctrl+Z défait le dernier geste où qu'il ait eu lieu,
// donc chaque état empilé est un instantané de la table entière.
type EditsByPath = Record<string, CutEdits>;
const editsFor = (table: EditsByPath, path: string): CutEdits => table[path] ?? EMPTY_EDITS;
const countEdits = (table: EditsByPath): number =>
  Object.values(table).reduce((n, e) => n + e.merges.length + e.removed.length, 0);

/** Ce qu'on sait d'un rush du flux : sa sonde, son nombre d'images et sa durée. */
export interface FlowSource {
  path: string;
  info: MediaInfo | null;
  srcFrames: number;
  duration: number;
  fps: number;
}
const EMPTY_SOURCE = (path: string): FlowSource => ({ path, info: null, srcFrames: 0, duration: 0, fps: 0 });

export interface ShotDetection {
  /** Les rushs du flux, dans l'ordre d'ouverture. Un rush seul = un flux d'un. */
  sources: FlowSource[];
  /** Ce qu'on sait du rush d'un plan. Jamais undefined : un plan hors flux rend une source vide. */
  sourceOf: (path: string | undefined) => FlowSource;
  /** Fichier d'un plan — son `path` s'il en a un, sinon le premier rush du flux. */
  pathOf: (s: Segment) => string;
  info: MediaInfo | null;      // sonde du PREMIER rush (entête)
  duration: number;            // durée TOTALE du flux
  segments: Segment[];         // plans de tous les rushs, à la suite, chacun portant son `path`
  setSegments: React.Dispatch<React.SetStateAction<Segment[]>>;
  detecting: boolean;
  cacheLoading: boolean;
  progress: number;
  active: Segment | null;
  setActive: React.Dispatch<React.SetStateAction<Segment | null>>;
  activeUrl: string | null;
  setActiveUrl: React.Dispatch<React.SetStateAction<string | null>>;
  err: string | null;
  setErr: React.Dispatch<React.SetStateAction<string | null>>;
  preset: number;
  setPreset: React.Dispatch<React.SetStateAction<number>>;
  model: DetectModel;
  setModel: React.Dispatch<React.SetStateAction<DetectModel>>;
  getProxy: (s: Segment, priority?: "high" | "low", height?: number, token?: number) => Promise<string | null>;
  /** Lecture SYNCHRONE du cache d'URL : la carte monte sa <video> sans attendre une promesse. */
  peekProxy: (s: Segment) => string | null;
  /** Oublie l'URL d'un plan : une <video> qui plante repart sur le chemin asynchrone. */
  bustProxy: (s: Segment) => void;
  /** Résout en UN appel les proxies déjà encodés et amorce le cache (aucun encode). */
  warmProxies: (list: Segment[], height?: number) => void;
  /** Pré-génère les proxies/vignettes des plans passés. Rappelée pendant un run = ARRÊT.
   *  Une FONCTION plutôt qu'un tableau = le run suit la liste affichée (cf. previewCache). */
  generateProxies: (source: PreviewSource<Segment>, height?: number) => Promise<void>;
  generateThumbs: (source: PreviewSource<Segment>) => Promise<void>;
  proxyGen: GenerationState | null;
  thumbsGen: GenerationState | null;
  playScene: (s: Segment) => Promise<void>;
  /** Découpe le flux. `only` restreint aux rushs donnés — les autres gardent leurs plans. */
  detect: (only?: string[]) => Promise<void>;
  // Édits persistés POUR LE MODÈLE COURANT, rush par rush : fusions (union de plans) et retraits.
  // `clearEdits` oublie ceux de tout le flux (re-détecte propre) sans toucher à l'autre modèle.
  hasEdits: boolean;
  recordMerge: (path: string, m: CutSpan) => void;
  recordRemoval: (spans: { path: string; span: CutSpan }[]) => void;
  clearEdits: () => void;
  undoEdit: () => void;
  redoEdit: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

// Tout le flux « détection de plans » : probe, détection IA (TransNetV2/OmniShotCut),
// rechargement du cache SQLite par clip+modèle, préchauffe vignettes/proxies, lecture du plan actif.
//
// Le hook travaille sur une SUITE de rushs, jamais sur un seul : ouvrir un rush isolé, c'est ouvrir
// un flux d'un. Une grille qui enchaîne quatre rushs n'est donc pas un mode à part — c'est le même
// code avec quatre entrées, ce qui est la seule façon de garantir qu'elle se comporte exactement
// comme une grille d'un seul rush (mêmes plans, même lecture, mêmes édits, même défilement).
export function useShotDetection(clipPaths: string[]): ShotDetection {
  const { t } = useTranslation("derush");
  // Cache d'URL, préchauffes et boutons de génération : implémentation PARTAGÉE avec Timeline Live,
  // Collections et la Recherche (cf. previewCache). Le Découpage n'a plus de copie à lui.
  const preview = usePreviewCache();

  // Identité du flux : c'est ELLE qui pilote les effets, pas le tableau (recréé à chaque rendu par
  // l'appelant). Deux ouvertures des mêmes rushs dans le même ordre = le même flux, zéro rechargement.
  const flowKey = clipPaths.join("\n");
  const paths = useMemo(() => (flowKey ? flowKey.split("\n") : []), [flowKey]);
  const firstPath = paths[0] ?? "";

  // Le cache lui-même est vidé par `previewCache` ; ici on ne remet à zéro que ce qui est propre au
  // studio — le plan chargé dans le lecteur pointe sur un proxy encodé avec les anciens réglages.
  useEffect(() => {
    const clear = () => setActiveUrl(null);
    window.addEventListener(PREVIEW_SETTINGS_EVENT, clear);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, clear);
  }, []);

  const [sources, setSources] = useState<FlowSource[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  // Plans affichés, lus au moment de l'appel : une découpe partielle doit conserver ceux des rushs
  // qu'elle ne touche pas, or elle démarre bien avant de savoir ce qu'elle va remplacer.
  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;
  const [detecting, setDetecting] = useState(false);
  // Vrai pendant le chargement async du cache SQLite à l'ouverture du flux/modèle : évite d'afficher
  // « Détecter pour découper » alors que les rushs sont déjà découpés (le cache n'a juste pas fini de
  // remonter). On montre un loader à la place pendant cette fenêtre de quelques secondes.
  const [cacheLoading, setCacheLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  // Défauts du module (panneau Paramètres). Lus À L'INIT seulement : changer le défaut ne doit pas
  // re-détecter le flux ouvert sous le nez de l'utilisateur.
  const [preset, setPreset] = useState(() => useApp.getState().cutPreset);
  const [model, setModel] = useState<DetectModel>(() => useApp.getState().cutModel);
  const detectionOptions = useApp((state) => state.detectionOptions);
  const scopedOptions = useMemo(() => detectionOptionsFor(model, detectionOptions), [model, detectionOptions]);
  const optionsScope = useMemo(() => detectionOptionsKey(model, detectionOptions), [model, detectionOptions]);
  const threshold = detectionThreshold(model, PRESETS[preset].thr, detectionOptions);
  const [err, setErr] = useState<string | null>(null);

  const [active, setActive] = useState<Segment | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);

  // Édits persistés du flux POUR LE MODÈLE COURANT (chargés à l'ouverture, réappliqués après
  // détection/cache). `editsEpoch` force le rechargement du cache quand la pile d'édits change sans
  // qu'on reconstruise les plans à la main (effacement, annuler/rétablir).
  const editsRef = useRef<EditsByPath>({});
  const [hasEdits, setHasEdits] = useState(false);
  const [editsEpoch, setEditsEpoch] = useState(0);
  // Historique = pile de SNAPSHOTS complets des édits. Les édits sont peu nombreux, donc copier
  // l'état entier coûte moins cher (et se raisonne bien mieux) qu'un journal d'opérations inverses.
  const pastRef = useRef<EditsByPath[]>([]);
  const futureRef = useRef<EditsByPath[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Table des sources tenue en ref : les helpers d'aperçu et d'export la lisent à l'appel, sans
  // entrer dans leurs dépendances (une sonde qui rentre re-créerait sinon tous les rappels des cartes).
  const sourcesRef = useRef<Map<string, FlowSource>>(new Map());
  sourcesRef.current = new Map(sources.map((s) => [s.path, s]));
  const sourceOf = useCallback(
    (path: string | undefined) => (path ? sourcesRef.current.get(path) : undefined) ?? EMPTY_SOURCE(path ?? firstPath),
    [firstPath],
  );
  // Un plan sans `path` vient d'une grille mono-rush : il appartient au premier (et seul) rush.
  const pathOf = useCallback((s: Segment) => s.path ?? firstPath, [firstPath]);

  const info = sources[0]?.info ?? null;
  const duration = sources.reduce((n, s) => n + s.duration, 0);

  // Aperçu d'un plan : le cache partagé est indexé par (fichier, plage), donc le lecteur latéral,
  // la carte de la grille et la pré-génération visent tous le MÊME fichier. `height` = hauteur réelle
  // de la cellule, mesurée côté carte, pour ne jamais encoder plus de pixels que ce qui s'affiche.
  const getProxy = (s: Segment, priority: "high" | "low" = "high", height?: number, token?: number) =>
    preview.getProxy(pathOf(s), s.in, s.out, priority, height, token);
  const peekProxy = (s: Segment) => preview.peekProxy(pathOf(s), s.in, s.out);
  const bustProxy = (s: Segment) => preview.bustProxy(pathOf(s), s.in, s.out);

  // Aucune préchauffe proxy spéculative : les proxys ne s'encodent qu'à la lecture réelle (survol /
  // lecture auto, cf. useSceneCardMedia) → le scroll ne déclenche aucun ffmpeg, pas de saturation
  // CPU/GPU à la réouverture. Les vignettes (cache disque, servies en nrmedia://) remplissent la
  // grille ; l'encode proxy suit la lecture, focalisé et dans l'ordre. `warmProxies` ne fait que
  // RÉSOUDRE les fichiers déjà encodés (cf. previewCache), il n'en fabrique aucun.
  const warmProxies = useCallback(
    (list: Segment[], height?: number) => preview.warmProxies(list.map((s) => ({ path: pathOf(s), in: s.in, out: s.out })), height),
    [pathOf, preview.warmProxies],
  );

  // Le fps sert au core à viser une IMAGE plutôt qu'un instant : il est donc pris rush par rush.
  // `fpsHint` couvre la passe qui suit immédiatement une détection, où la sonde n'est pas encore
  // dans l'état mais où la réponse du détecteur, elle, porte le fps.
  const warmThumbs = useCallback(
    (list: Segment[], fpsHint?: Map<string, number>) => preview.warmThumbs(list.map((s) => {
      const path = pathOf(s);
      return { path, in: s.in, out: s.out, inFrame: s.inFrame, fps: fpsHint?.get(path) ?? sourceOf(path).fps };
    })),
    [pathOf, sourceOf, preview.warmThumbs],
  );

  // Boutons « pré-générer » de la barre d'outils : mêmes pools bornés que Timeline Live et
  // Collections, puisque c'est le même code (cf. previewCache).
  const asShots = (source: PreviewSource<Segment>) => () =>
    (typeof source === "function" ? source() : source)
      .map((s) => { const path = pathOf(s); return { path, in: s.in, out: s.out, inFrame: s.inFrame, fps: sourceOf(path).fps }; });
  const generateProxies = (source: PreviewSource<Segment>, height?: number) =>
    preview.generateProxies(asShots(source), height);
  const generateThumbs = (source: PreviewSource<Segment>) =>
    preview.generateThumbs(asShots(source));

  async function playScene(s: Segment) {
    setErr(null);
    // Une seule identité par plan : si la grille l'a déjà généré on réutilise exactement son URL ;
    // sinon cette même fonction crée le proxy puis le place dans le cache partagé.
    const u = await getProxy(s, "high");
    if (u) {
      setActive(s);
      setActiveUrl(u);
    } else {
      setErr(t("detection.proxyPrefix", { error: t("shared.failed") }));
    }
  }

  // `only` = ne (re)découper que ces rushs, et garder les plans déjà en place pour les autres.
  // Sert au flux : compléter les rushs pas encore découpés ne doit pas repasser le détecteur sur
  // ceux qui le sont — c'est des minutes de GPU pour un résultat identique.
  async function detect(only?: string[]) {
    if (!paths.length) return;
    const wanted = only?.length ? new Set(only) : null;
    const targets = wanted ? paths.filter((p) => wanted.has(p)) : paths;
    if (!targets.length) return;
    useApp.getState().offerCloseForRam();
    setDetecting(true); setProgress(0); setErr(null);
    // Découpe partielle : les proxies des rushs qu'on ne touche pas restent valides, les jeter
    // ferait ré-encoder toute la grille au premier survol.
    if (!wanted) preview.clearProxies();
    // Filtre par chemin : plusieurs détections tournent en parallèle (batch/board) → ne prend que
    // la progression du rush EN COURS (sans filtre, la barre sautait au rythme des autres jobs).
    // Lissée : la détection est muette pendant le chargement du modèle et la lecture full-vidéo.
    // Sur un flux, la barre couvre la SUITE ENTIÈRE : la part des rushs finis plus celle du rush
    // en cours, plafonnée à la fin de sa part — un rush qui termine ne fait donc jamais reculer.
    const track = createSmoothProgress(setProgress);
    const share = 100 / targets.length;
    let doneClips = 0;
    let current = targets[0];
    const off = nr.onScenesProgress((p) => {
      if (p.path != null && p.path !== current) return;
      track.to(Math.round(doneClips * share + (p.pct / 100) * share), Math.round((doneClips + 1) * share));
    });
    try {
      const fresh = new Map<string, Segment[]>();
      const fpsHint = new Map<string, number>();
      const probed: FlowSource[] = [];
      const failed: string[] = [];
      for (const path of targets) {
        current = path;
        try {
          const r = await nr.detectScenes(path, threshold, model, scopedOptions);
          if (r.error) { failed.push(r.error); continue; }
          const dur = r.duration || sourceOf(path).duration;
          const fps = r.fps || (r.frames && dur ? r.frames / dur : 0);
          fpsHint.set(path, fps);
          probed.push({ path, info: sourceOf(path).info, srcFrames: r.frames || 0, duration: dur, fps });
          let segs: Segment[] = (r.scenes || []).flatMap((s) =>
            s.end > s.start
              ? [{ id: nextSegId(), in: s.start, out: s.end, inFrame: s.startFrame, outFrame: s.endFrame, path }]
              : []);
          if (segs.length === 0 && dur > 0) segs = [{ id: nextSegId(), in: 0, out: dur, path }];
          fresh.set(path, applyEdits(segs, editsFor(editsRef.current, path)));   // rejoue les fusions/retraits gardés
        } catch (e) { failed.push(String(e)); }
        doneClips++;
        track.to(Math.round(doneClips * share));
      }
      if (probed.length) {
        setSources((prev) => prev.map((s) => probed.find((p) => p.path === s.path) ?? s));
      }
      // Un rush en échec ne fait pas tomber les autres : on garde ce qui a été détecté et on dit
      // ce qui a manqué. Perdre neuf découpes parce que la dixième a échoué serait absurde.
      if (failed.length) setErr(failed[0]);
      if (!fresh.size && failed.length) return;
      // Réassemblage DANS L'ORDRE DU FLUX : les rushs re-détectés prennent leurs nouveaux plans,
      // les autres gardent exactement les leurs, et la grille ne se réordonne pas sous le curseur.
      const kept = new Map<string, Segment[]>();
      for (const s of segmentsRef.current) {
        const p = s.path ?? firstPath;
        const group = kept.get(p);
        if (group) group.push(s); else kept.set(p, [s]);
      }
      const all = paths.flatMap((p) => fresh.get(p) ?? kept.get(p) ?? []);
      setSegments(all);
      toast.ok(t("detection.shotsWithModel", { count: all.length, model: modelLabel(model) }));
      warmThumbs(all, fpsHint);
    } catch (e) { setErr(String(e)); }
    finally { off(); track.stop(); setDetecting(false); }
  }

  // Helpers recréés à chaque rendu (capturent le flux) ; on les lit via ref pour que l'effet de
  // rechargement du cache ne dépende que de [flowKey, model] sans relancer à chaque rendu, tout en
  // appelant toujours la dernière version.
  const helpersRef = useRef({ warmThumbs, playScene });
  useEffect(() => { helpersRef.current = { warmThumbs, playScene }; }, [playScene, warmThumbs]);

  // Sonde de CHAQUE rush du flux, en parallèle. La table est posée d'un coup, dans l'ordre du flux :
  // les rushs n'apparaissent jamais un par un dans l'entête au rythme des réponses.
  useEffect(() => {
    let alive = true;
    if (!paths.length) { setSources([]); return; }
    setSources(paths.map(EMPTY_SOURCE));
    void Promise.all(paths.map((path) =>
      // La sonde ne rend ni images ni fps : ceux-là viennent du cache de découpe ou du détecteur.
      nr.probe(path).then((m): FlowSource => ({
        path, info: m, srcFrames: 0, duration: m?.duration || 0, fps: 0,
      })).catch(() => EMPTY_SOURCE(path)),
    )).then((probed) => { if (alive) setSources(probed); });
    return () => { alive = false; };
  }, [paths]);

  // À l'OUVERTURE d'un flux : auto-sélectionne le modèle qui a déjà un cache de plans. Sinon on
  // atterrit sur transnetv2 (défaut) vide alors que les rushs ont été découpés en omnishot (ou
  // l'inverse). Le PREMIER rush décide — c'est celui qu'on voit en haut de la grille, et un flux
  // se coupe de toute façon avec un seul modèle. Ne se déclenche PAS sur un changement de modèle
  // manuel (flux stable) → respecte le choix de l'utilisateur en cours de session.
  useEffect(() => {
    let alive = true;
    if (!firstPath) return;
    (async () => {
      // Modèle courant déjà en cache → rien à faire.
      const cur = await nr.cachedScenes(firstPath, model).catch(() => null);
      if (!alive || (cur?.cached && cur.scenes.length)) return;
      // Sinon bascule sur le premier autre modèle qui a un cache.
      for (const m of MODELS) {
        if (m.id === model) continue;
        const r = await nr.cachedScenes(firstPath, m.id).catch(() => null);
        if (!alive) return;
        if (r?.cached && r.scenes.length) { setModel(m.id); return; }
      }
    })();
    return () => { alive = false; };
    // model lu volontairement hors deps : auto-sélection à l'ouverture du flux seulement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstPath]);

  // L'historique appartient au couple (flux, modèle) : en changer le vide, sinon un Ctrl+Z écraserait
  // les édits d'un autre modèle avec un état qui ne le concerne pas. Volontairement séparé de l'effet
  // de cache ci-dessous, qui retire AUSSI sur editsEpoch — or annuler/rétablir bumpe cet epoch et ne
  // doit surtout pas détruire la pile qu'il vient d'utiliser.
  useEffect(() => {
    pastRef.current = [];
    futureRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }, [flowKey, model]);

  // cache SQLite par modèle : recharge instantanément les plans déjà détectés, PUIS rejoue les édits
  // persistés pour CE modèle (chargés ici pour éviter toute course avec l'affichage des plans).
  //
  // Tous les rushs du flux sont lus EN PARALLÈLE et publiés EN UNE FOIS. C'est ce qui fait qu'un flux
  // défile comme un rush unique : la grille n'a jamais un rush de moins qui s'ajoute en cours de
  // route, donc rien n'apparaît sous le curseur ni ne déplace ce qu'on est en train de regarder.
  useEffect(() => {
    let alive = true;
    // Vide l'état du flux précédent avant le rechargement async du cache (flux/modèle changé).
    setSegments([]); setActive(null); setActiveUrl(null);
    setErr(null);
    setCacheLoading(true);
    if (!paths.length) { setCacheLoading(false); return; }
    (async () => {
      const loaded = await Promise.all(paths.map(async (path) => {
        const [exact, eres] = await Promise.all([
          nr.cachedScenes(path, model, threshold, scopedOptions),
          nr.getCutEdits(path, model, optionsScope).catch(() => EMPTY_EDITS),
        ]);
        // Le cache est indexé sur (fichier, modèle, SEUIL, options) : un rush découpé avec d'autres
        // réglages ressortait « pas découpé » alors que ses plans sont sur disque. À défaut d'exact,
        // on sert la découpe la plus récente de ce modèle — mieux vaut montrer les plans connus que
        // demander une re-détection identique.
        const r = exact.scenes?.length ? exact : (await nr.cachedScenes(path, model).catch(() => exact));
        return { path, r, edits: { merges: eres.merges || [], removed: eres.removed || [] } as CutEdits };
      }));
      if (!alive) return;
      const table: EditsByPath = {};
      for (const { path, edits } of loaded) table[path] = edits;
      editsRef.current = table;
      setHasEdits(countEdits(table) > 0);

      const all: Segment[] = [];
      const probed: FlowSource[] = [];
      const fpsHint = new Map<string, number>();
      for (const { path, r, edits } of loaded) {
        if (!r.scenes?.length) continue;
        const dur = r.duration || sourceOf(path).duration;
        const fps = r.fps || (r.frames && dur ? r.frames / dur : 0);
        fpsHint.set(path, fps);
        probed.push({ path, info: sourceOf(path).info, srcFrames: r.frames || 0, duration: dur, fps });
        const segs: Segment[] = r.scenes.flatMap((s) =>
          s.end > s.start
            ? [{ id: nextSegId(), in: s.start, out: s.end, inFrame: s.startFrame, outFrame: s.endFrame, path }]
            : []);
        all.push(...applyEdits(segs, edits));   // rejoue les fusions/retraits gardés
      }
      if (probed.length) {
        setSources((prev) => prev.map((s) => {
          const p = probed.find((x) => x.path === s.path);
          // La sonde reste la source de vérité pour `info` : le cache ne rapporte que les frames.
          return p ? { ...p, info: s.info ?? p.info, duration: s.duration || p.duration } : s;
        }));
      }
      if (!all.length) return;
      // Réouverture = plans connus instantanément (cache SQLite) → on RÉVÈLE TOUT DE SUITE, sans
      // attendre les vignettes (elles sont sur disque → chargées en lazy/cache renderer, rapides).
      // Ne jamais bloquer ici sur des vignettes : un seek ffmpeg lent retarderait toute la page.
      setSegments(all);
      helpersRef.current.warmThumbs(all, fpsHint);
      // À la réouverture d'un flux déjà détecté, la grille reste visible mais le lecteur latéral
      // reste sans source : il ne doit charger/lire qu'après une action explicite sur une carte
      // (double-clic, menu Lire ou raccourci P).
    })().finally(() => { if (alive) setCacheLoading(false); });
    return () => { alive = false; };
    // `sourceOf` lit une ref (identité stable au flux) : l'ajouter aux deps relancerait le cache à
    // chaque sonde qui rentre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, model, threshold, optionsScope, editsEpoch]);

  // Pose un nouvel état d'édits : empile l'ancien pour l'annulation, coupe la branche de rétablissement
  // (on repart d'ici), persiste POUR LE MODÈLE COURANT. Le collapse visuel est fait par l'appelant
  // (setSegments) — pas de bump d'epoch, sinon chaque fusion rechargerait toute la grille.
  // `touched` = les rushs dont les édits ont bougé : eux seuls sont réécrits sur disque.
  function pushEdits(next: EditsByPath, touched: string[]) {
    pastRef.current = [...pastRef.current, editsRef.current];
    futureRef.current = [];
    editsRef.current = next;
    setHasEdits(countEdits(next) > 0);
    setCanUndo(true);
    setCanRedo(false);
    for (const path of touched) void nr.saveCutEdits(path, model, editsFor(next, path), optionsScope);
  }
  // Applique un état venu de l'historique : persiste puis bump l'epoch → l'effet de cache re-dérive
  // les plans de zéro. applyEdits étant déterministe, c'est exact sans réparer les plans à la main.
  // Tout le flux est réécrit : on ne sait pas lequel des rushs le pas d'historique concernait.
  function restoreEdits(next: EditsByPath) {
    editsRef.current = next;
    setHasEdits(countEdits(next) > 0);
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
    for (const path of paths) void nr.saveCutEdits(path, model, editsFor(next, path), optionsScope);
    setEditsEpoch((e) => e + 1);
  }

  // Enregistre une fusion (union de plans) DANS SON RUSH → persistée immédiatement, rejouée à la
  // prochaine détection/réouverture de ce rush SOUS CE MODÈLE.
  function recordMerge(path: string, m: CutSpan) {
    const cur = editsFor(editsRef.current, path);
    pushEdits({ ...editsRef.current, [path]: { merges: [...cur.merges, m], removed: cur.removed } }, [path]);
  }
  // Écarte des plans de la découpe → ils ne reviennent plus, même après re-détection. Une sélection
  // peut traverser plusieurs rushs : chacun reçoit les siens.
  function recordRemoval(spans: { path: string; span: CutSpan }[]) {
    if (!spans.length) return;
    const next: EditsByPath = { ...editsRef.current };
    const touched = new Set<string>();
    for (const { path, span } of spans) {
      const cur = editsFor(next, path);
      next[path] = { merges: cur.merges, removed: [...cur.removed, span] };
      touched.add(path);
    }
    pushEdits(next, [...touched]);
  }
  // Oublie les édits du flux POUR CE MODÈLE et recharge une découpe propre (l'autre modèle garde les
  // siens). Annulable comme le reste : l'état effacé part sur la pile.
  function clearEdits() {
    pastRef.current = [...pastRef.current, editsRef.current];
    futureRef.current = [];
    editsRef.current = {};
    setHasEdits(false);
    setCanUndo(true);
    setCanRedo(false);
    for (const path of paths) void nr.clearCutEdits(path, model, optionsScope);
    setEditsEpoch((e) => e + 1);
  }
  function undoEdit() {
    const prev = pastRef.current[pastRef.current.length - 1];
    if (!prev) return;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [editsRef.current, ...futureRef.current];
    restoreEdits(prev);
  }
  function redoEdit() {
    const next = futureRef.current[0];
    if (!next) return;
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current, editsRef.current];
    restoreEdits(next);
  }

  return {
    sources, sourceOf, pathOf,
    info, duration, segments, setSegments, detecting, cacheLoading, progress,
    active, setActive, activeUrl, setActiveUrl,
    err, setErr, preset, setPreset, model, setModel,
    getProxy, peekProxy, bustProxy, warmProxies, playScene, detect,
    generateProxies, generateThumbs, proxyGen: preview.proxyGen, thumbsGen: preview.thumbsGen,
    hasEdits, recordMerge, recordRemoval, clearEdits, undoEdit, redoEdit, canUndo, canRedo,
  };
}
