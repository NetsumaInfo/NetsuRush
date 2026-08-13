import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { nr, type MediaInfo, type DetectModel, type CutSpan, type CutEdits } from "@/lib/bridge";
import { useApp } from "@/store";
import { getThumb, warmResolveThumbs } from "@/lib/thumbCache";
import { thumbTime } from "@/lib/utils";
import { PREVIEW_SETTINGS_EVENT } from "@/lib/previewSettings";
import { detectionOptionsFor, detectionOptionsKey, detectionThreshold } from "@/lib/detection";
import { createSmoothProgress } from "@/lib/smoothProgress";
import { toast } from "@/components/ui/toast";
import {
  nextSegId, modelLabel, resetPlaySlots, PRESETS, MODELS, type Segment,
} from "./cutStudioShared";

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
    const merged: Segment = { id: nextSegId(), in: first.in, out: last.out, inFrame: first.inFrame, outFrame: last.outFrame };
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
const WARM_PROXY_DEBOUNCE_MS = 150;

export interface ShotDetection {
  info: MediaInfo | null;
  duration: number;
  segments: Segment[];
  setSegments: React.Dispatch<React.SetStateAction<Segment[]>>;
  srcFrames: number;
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
  proxyCache: Map<number, string>;
  getProxy: (s: Segment, priority?: "high" | "low", height?: number, token?: number) => Promise<string | null>;
  /** Résout en UN appel les proxies déjà en cache et remplit `proxyCache` (aucun encode). */
  warmProxies: (list: Segment[], height?: number) => void;
  playScene: (s: Segment) => Promise<void>;
  detect: () => Promise<void>;
  // Édits persistés du rush POUR LE MODÈLE COURANT : fusions (union de plans) et retraits.
  // `clearEdits` oublie tout (re-détecte propre) sans toucher aux édits de l'autre modèle.
  hasEdits: boolean;
  recordMerge: (m: CutSpan) => void;
  recordRemoval: (spans: CutSpan[]) => void;
  clearEdits: () => void;
  undoEdit: () => void;
  redoEdit: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

// Tout le flux « détection de plans » : probe, détection IA (TransNetV2/OmniShotCut),
// rechargement du cache SQLite par clip+modèle, préchauffe vignettes/proxies, lecture du plan actif.
export function useShotDetection(clipPath: string): ShotDetection {
  const { t } = useTranslation("derush");
  const proxyCacheRef = useRef<Map<number, string> | null>(null);
  if (proxyCacheRef.current === null) proxyCacheRef.current = new Map();
  const proxyCache = proxyCacheRef.current;
  const proxyPendingRef = useRef<Map<number, Promise<string | null>>>(new Map());

  useEffect(() => {
    const clear = () => {
      proxyCache.clear();
      proxyPendingRef.current.clear();
      setActiveUrl(null);
    };
    window.addEventListener(PREVIEW_SETTINGS_EVENT, clear);
    return () => window.removeEventListener(PREVIEW_SETTINGS_EVENT, clear);
  }, [proxyCache]);

  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [detecting, setDetecting] = useState(false);
  // Vrai pendant le chargement async du cache SQLite à l'ouverture du clip/modèle : évite d'afficher
  // « Détecter pour découper » alors que le rush est déjà découpé (le cache n'a juste pas fini de
  // remonter). On montre un loader à la place pendant cette fenêtre de quelques secondes.
  const [cacheLoading, setCacheLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  // Défauts du module (panneau Paramètres). Lus À L'INIT seulement : changer le défaut ne doit pas
  // re-détecter le rush ouvert sous le nez de l'utilisateur.
  const [preset, setPreset] = useState(() => useApp.getState().cutPreset);
  const [model, setModel] = useState<DetectModel>(() => useApp.getState().cutModel);
  const detectionOptions = useApp((state) => state.detectionOptions);
  const scopedOptions = useMemo(() => detectionOptionsFor(model, detectionOptions), [model, detectionOptions]);
  const optionsScope = useMemo(() => detectionOptionsKey(model, detectionOptions), [model, detectionOptions]);
  const threshold = detectionThreshold(model, PRESETS[preset].thr, detectionOptions);
  const [srcFrames, setSrcFrames] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const [active, setActive] = useState<Segment | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);

  // Édits persistés du rush courant POUR LE MODÈLE COURANT (chargés à l'ouverture, réappliqués après
  // détection/cache). `editsEpoch` force le rechargement du cache quand la pile d'édits change sans
  // qu'on reconstruise les plans à la main (effacement, annuler/rétablir).
  const editsRef = useRef<CutEdits>(EMPTY_EDITS);
  const [hasEdits, setHasEdits] = useState(false);
  const [editsEpoch, setEditsEpoch] = useState(0);
  // Historique = pile de SNAPSHOTS complets des édits. Les édits sont peu nombreux, donc copier
  // l'état entier coûte moins cher (et se raisonne bien mieux) qu'un journal d'opérations inverses.
  const pastRef = useRef<CutEdits[]>([]);
  const futureRef = useRef<CutEdits[]>([]);
  const warmPollsRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const warmProxyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (warmProxyTimer.current) clearTimeout(warmProxyTimer.current); }, []);
  useEffect(() => () => {
    warmPollsRef.current.forEach((timer) => clearInterval(timer));
    warmPollsRef.current.clear();
  }, []);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const duration = info?.duration || 0;

  // height = hauteur RÉELLE de la cellule (mesurée côté carte) → proxy à la bonne résolution.
  // Cache par id (premier écrit gagne) : la taille de cellule est stable tant qu'on ne change pas
  // les colonnes ; un éventuel décalage de palier reste cosmétique (cellule minuscule).
  async function getProxy(s: Segment, priority: "high" | "low" = "high", height?: number, token?: number): Promise<string | null> {
    const c = proxyCache.get(s.id);
    if (c) return c;
    const pending = proxyPendingRef.current.get(s.id);
    if (pending) return pending;
    const request = nr.proxy({ input: clipPath, start: s.in, end: s.out, priority, height, token })
      .then((r) => {
        if (!r.ok || !r.path) return null;
        const u = nr.assetUrl(r.path);
        proxyCache.set(s.id, u);
        return u;
      })
      .finally(() => proxyPendingRef.current.delete(s.id));
    proxyPendingRef.current.set(s.id, request);
    return request;
  }

  // Aucune préchauffe proxy spéculative : les proxys ne s'encodent qu'à la lecture réelle (survol /
  // lecture auto, cf. useSceneCardMedia) → le scroll ne déclenche aucun ffmpeg, pas de saturation
  // CPU/GPU à la réouverture. Les vignettes (cache disque, servies en nrmedia://) remplissent la
  // grille ; l'encode proxy suit la lecture, focalisé et dans l'ordre.

  // Amorce le cache d'URL des proxies DÉJÀ encodés, en UN appel — pendant symétrique de
  // `warmResolveThumbs` pour les vignettes.
  //
  // Sans lui, une carte ne peut pas connaître l'URL de son aperçu sans demander « ffmpeg:proxy » au
  // core, MÊME quand le fichier est déjà sur disque : chaque carte qui entre dans la bande émet son
  // RPC, passe par la file d'encodage, réécrit son sidecar, puis se fait annuler en ressortant. Au
  // défilement ça fait des centaines d'allers-retours pour des fichiers tous présents, et la grille
  // reste sur ses vignettes — le symptôme « ça ne joue pas quand je scrolle ». Ici, tout est résolu
  // d'un coup : la carte trouve son URL dans le cache et monte sa <video> sans rien demander.
  //
  // `height` doit être le palier RÉELLEMENT utilisé à l'encodage (il entre dans la clé de cache) :
  // l'appelant passe la hauteur de cellule mesurée, comme la pré-génération.
  const warmProxies = useCallback((list: Segment[], height?: number) => {
    const missing = list.filter((s) => !proxyCache.has(s.id));
    if (!missing.length) return;
    const items = missing.map((s) => ({ input: clipPath, start: s.in, end: s.out }));
    // Anti-rafale : la hauteur de cellule vient d'un ResizeObserver et des boutons de densité, donc
    // l'appelant nous relance à chaque pixel pendant un redimensionnement. Côté core, chaque
    // résolution lit le dossier de proxies — une rafale mettrait le service à genoux pendant que la
    // grille se réagence. Une liste déjà résolue sort plus haut sans même armer le minuteur.
    if (warmProxyTimer.current) clearTimeout(warmProxyTimer.current);
    warmProxyTimer.current = setTimeout(() => {
      warmProxyTimer.current = null;
      void nr.proxyResolve(items, { height })
        .then((rows) => {
          const byRange = new Map(rows.filter((r) => r.file).map((r) => [`${r.start}|${r.end}`, r.file as string]));
          for (const s of missing) {
            const file = byRange.get(`${s.in}|${s.out}`);
            // Le cache peut avoir été rempli entre-temps par une lecture réelle : premier écrit gagne.
            if (file && !proxyCache.has(s.id)) proxyCache.set(s.id, nr.assetUrl(file));
          }
        })
        .catch(() => { /* best-effort : les cartes repartent sur l'encode à la demande */ });
    }, WARM_PROXY_DEBOUNCE_MS);
  }, [clipPath, proxyCache]);

  // Pré-génère toutes les vignettes en un seul passage ffmpeg (réouverture à froid = aussi
  // rapide que juste après la détection, où le fichier est chaud dans le cache disque de l'OS).
  const warmThumbs = useCallback((list: Segment[], fps: number) => {
    if (!list.length) return;
    const items = list.map((s) => ({ path: clipPath, time: thumbTime(s.in, s.out) }));
    // Résout EN UN RPC les vignettes déjà sur disque → amorce le cache renderer, les cartes
    // s'affichent sans 1 RPC chacune (scroll fluide).
    void warmResolveThumbs(items);
    // 1re génération : thumbsBatch écrit les vignettes sur disque AU FIL DE L'EAU mais ne renvoie
    // PAS les chemins. Sans ré-amorçage, chaque carte tire son propre RPC au scroll (sockets HTTP
    // saturés → apparition lente). On ré-amorce le cache renderer pendant la génération (les
    // vignettes tombent progressivement) ET au terme → mêmes perfs qu'à la réouverture, même session.
    //
    // Chaque tour ne redemande que les vignettes ENCORE absentes du cache renderer : le core fait un
    // `stat` par entrée, donc repasser la liste entière d'un rush de plusieurs centaines de plans
    // toutes les 1,5 s pilonnait le disque exactement pendant qu'on défile.
    const pending = () => items.filter((it) => !getThumb(it.path, it.time));
    const poll = setInterval(() => {
      const missing = pending();
      if (!missing.length) return;
      void warmResolveThumbs(missing);
    }, 1500);
    warmPollsRef.current.add(poll);
    nr.thumbsBatch(clipPath, list.map((s) => {
      const t = thumbTime(s.in, s.out);
      return { time: t, frame: fps ? Math.round(t * fps) : (s.inFrame ?? 0) };
    }))
      .catch(() => {})
      .finally(() => {
        clearInterval(poll);
        warmPollsRef.current.delete(poll);
        const missing = pending();
        if (missing.length) void warmResolveThumbs(missing);
      });
  }, [clipPath]);

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

  async function detect() {
    useApp.getState().offerCloseForRam();
    setDetecting(true); setProgress(0); setErr(null);
    proxyCache.clear();
    proxyPendingRef.current.clear();
    // Filtre par chemin : plusieurs détections tournent en parallèle (batch/board) → ne prend que
    // la progression de CE clip (sans filtre, la barre sautait au rythme des autres jobs).
    // Lissée : la détection est muette pendant le chargement du modèle et la lecture full-vidéo.
    const track = createSmoothProgress(setProgress);
    const off = nr.onScenesProgress((p) => {
      if (p.path == null || p.path === clipPath) track.to(p.pct);
    });
    try {
      const r = await nr.detectScenes(clipPath, threshold, model, scopedOptions);
      if (r.error) { setErr(r.error); return; }
      setSrcFrames(r.frames || 0);
      const dur = r.duration || duration;
      let segs: Segment[] = (r.scenes || []).flatMap((s) =>
        s.end > s.start
          ? [{ id: nextSegId(), in: s.start, out: s.end, inFrame: s.startFrame, outFrame: s.endFrame }]
          : []);
      if (segs.length === 0 && dur > 0) segs = [{ id: nextSegId(), in: 0, out: dur }];
      segs = applyEdits(segs, editsRef.current);   // rejoue les fusions/retraits gardés
      setSegments(segs);
      toast.ok(t("detection.shotsWithModel", { count: segs.length, model: modelLabel(model) }));
      warmThumbs(segs, r.fps || (r.frames && dur ? r.frames / dur : 0));
    } catch (e) { setErr(String(e)); }
    finally { off(); track.stop(); setDetecting(false); }
  }

  // Helpers recréés à chaque rendu (capturent clipPath/duration) ; on les lit via ref pour que
  // l'effet de rechargement du cache ne dépende que de [clipPath, model] sans relancer à chaque
  // rendu, tout en appelant toujours la dernière version.
  const helpersRef = useRef({ warmThumbs, playScene });
  useEffect(() => { helpersRef.current = { warmThumbs, playScene }; }, [playScene, warmThumbs]);

  // État des créneaux de lecture remis à zéro à l'entrée/sortie du studio (évite l'héritage
  // d'un compteur faussé d'une session précédente → « Lecture auto » fiable à la réouverture).
  useEffect(() => { resetPlaySlots(); return () => resetPlaySlots(); }, []);

  useEffect(() => {
    let alive = true;
    nr.probe(clipPath).then((m) => alive && setInfo(m));
    return () => { alive = false; };
  }, [clipPath]);

  // À l'OUVERTURE d'un rush (changement de clip uniquement) : auto-sélectionne le modèle qui a
  // déjà un cache de plans. Sinon on atterrit sur transnetv2 (défaut) vide alors que le rush a été
  // découpé en omnishot (ou l'inverse). Ne se déclenche PAS sur un changement de modèle manuel
  // (clip stable) → respecte le choix de l'utilisateur en cours de session.
  useEffect(() => {
    let alive = true;
    (async () => {
      // Modèle courant déjà en cache → rien à faire.
      const cur = await nr.cachedScenes(clipPath, model).catch(() => null);
      if (!alive || (cur?.cached && cur.scenes.length)) return;
      // Sinon bascule sur le premier autre modèle qui a un cache.
      for (const m of MODELS) {
        if (m.id === model) continue;
        const r = await nr.cachedScenes(clipPath, m.id).catch(() => null);
        if (!alive) return;
        if (r?.cached && r.scenes.length) { setModel(m.id); return; }
      }
    })();
    return () => { alive = false; };
    // model lu volontairement hors deps : auto-sélection à l'ouverture du clip seulement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipPath]);

  // L'historique appartient au couple (rush, modèle) : en changer le vide, sinon un Ctrl+Z écraserait
  // les édits d'un autre modèle avec un état qui ne le concerne pas. Volontairement séparé de l'effet
  // de cache ci-dessous, qui retire AUSSI sur editsEpoch — or annuler/rétablir bumpe cet epoch et ne
  // doit surtout pas détruire la pile qu'il vient d'utiliser.
  useEffect(() => {
    pastRef.current = [];
    futureRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }, [clipPath, model]);

  // cache SQLite par modèle : recharge instantanément les plans déjà détectés, PUIS rejoue les édits
  // persistés du rush pour CE modèle (chargés ici pour éviter toute course avec l'affichage des plans).
  useEffect(() => {
    let alive = true;
    resetPlaySlots();
    // Vide l'état du clip précédent avant le rechargement async du cache (clip/modèle changé).
    setSegments([]); setActive(null); setActiveUrl(null);
    setErr(null);
    setCacheLoading(true);
    (async () => {
      const [exact, eres] = await Promise.all([
        nr.cachedScenes(clipPath, model, threshold, scopedOptions),
        nr.getCutEdits(clipPath, model, optionsScope).catch(() => EMPTY_EDITS),
      ]);
      if (!alive) return;
      // Le cache est indexé sur (fichier, modèle, SEUIL, options) : un rush découpé avec d'autres
      // réglages ressortait « pas découpé » alors que ses plans sont sur disque. À défaut d'exact,
      // on sert la découpe la plus récente de ce modèle — mieux vaut montrer les plans connus que
      // demander une re-détection identique.
      const r = exact.scenes?.length ? exact : (await nr.cachedScenes(clipPath, model).catch(() => exact));
      if (!alive) return;
      editsRef.current = { merges: eres.merges || [], removed: eres.removed || [] };
      setHasEdits(editsRef.current.merges.length + editsRef.current.removed.length > 0);
      if (!r.scenes?.length) return;
      let segs: Segment[] = r.scenes.flatMap((s) =>
        s.end > s.start
          ? [{ id: nextSegId(), in: s.start, out: s.end, inFrame: s.startFrame, outFrame: s.endFrame }]
          : []);
      segs = applyEdits(segs, editsRef.current);   // rejoue les fusions/retraits gardés
      // Réouverture = plans connus instantanément (cache SQLite) → on RÉVÈLE TOUT DE SUITE, sans
      // attendre les vignettes (elles sont sur disque → chargées en lazy/cache renderer, rapides).
      // Ne jamais bloquer ici sur des vignettes : un seek ffmpeg lent retarderait toute la page.
      setSegments(segs);
      setSrcFrames(r.frames || 0);
      helpersRef.current.warmThumbs(segs, r.fps || (r.frames && r.duration ? r.frames / r.duration : 0));
      // À la réouverture d'un rush déjà détecté, la grille reste visible mais le lecteur latéral
      // reste sans source : il ne doit charger/lire qu'après une action explicite sur une carte
      // (double-clic, menu Lire ou raccourci P).
    })().finally(() => { if (alive) setCacheLoading(false); });
    return () => { alive = false; };
  }, [clipPath, model, threshold, optionsScope, editsEpoch]);

  // Pose un nouvel état d'édits : empile l'ancien pour l'annulation, coupe la branche de rétablissement
  // (on repart d'ici), persiste POUR LE MODÈLE COURANT. Le collapse visuel est fait par l'appelant
  // (setSegments) — pas de bump d'epoch, sinon chaque fusion rechargerait toute la grille.
  function pushEdits(next: CutEdits) {
    pastRef.current = [...pastRef.current, editsRef.current];
    futureRef.current = [];
    editsRef.current = next;
    setHasEdits(next.merges.length + next.removed.length > 0);
    setCanUndo(true);
    setCanRedo(false);
    void nr.saveCutEdits(clipPath, model, next, optionsScope);
  }
  // Applique un état venu de l'historique : persiste puis bump l'epoch → l'effet de cache re-dérive
  // les plans de zéro. applyEdits étant déterministe, c'est exact sans réparer les plans à la main.
  function restoreEdits(next: CutEdits) {
    editsRef.current = next;
    setHasEdits(next.merges.length + next.removed.length > 0);
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
    void nr.saveCutEdits(clipPath, model, next, optionsScope);
    setEditsEpoch((e) => e + 1);
  }

  // Enregistre une fusion (union de plans) → persistée immédiatement, rejouée à la prochaine
  // détection/réouverture du rush SOUS CE MODÈLE.
  function recordMerge(m: CutSpan) {
    pushEdits({ merges: [...editsRef.current.merges, m], removed: editsRef.current.removed });
  }
  // Écarte des plans de la découpe → ils ne reviennent plus, même après re-détection.
  function recordRemoval(spans: CutSpan[]) {
    if (!spans.length) return;
    pushEdits({ merges: editsRef.current.merges, removed: [...editsRef.current.removed, ...spans] });
  }
  // Oublie les édits du rush POUR CE MODÈLE et recharge une découpe propre (l'autre modèle garde les
  // siens). Annulable comme le reste : l'état effacé part sur la pile.
  function clearEdits() {
    pastRef.current = [...pastRef.current, editsRef.current];
    futureRef.current = [];
    editsRef.current = EMPTY_EDITS;
    setHasEdits(false);
    setCanUndo(true);
    setCanRedo(false);
    void nr.clearCutEdits(clipPath, model, optionsScope);
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
    info, duration, segments, setSegments, srcFrames, detecting, cacheLoading, progress,
    active, setActive, activeUrl, setActiveUrl,
    err, setErr, preset, setPreset, model, setModel,
    proxyCache, getProxy, warmProxies, playScene, detect,
    hasEdits, recordMerge, recordRemoval, clearEdits, undoEdit, redoEdit, canUndo, canRedo,
  };
}
