import { useCallback, useEffect, useRef, useState } from "react";
import { nr, type RotoProgress } from "@/lib/bridge";
import type { UpSource } from "@/components/upscale/upscaleShared";
import {
  type RotoMatteParams, type RotoObject, type RotoPoint, type RotoPostState,
  type RotoRemoveParams, type RotoViewMode, type RotoViewState,
  DEFAULT_MATTE_PARAMS, DEFAULT_POST, DEFAULT_REMOVE_PARAMS, DEFAULT_VIEW, SAM_MODELS,
} from "./rotoShared";
import { useApp } from "@/store";
import i18n from "@/i18n";

const lsGet = (k: string, def: string) => { try { return localStorage.getItem(k) || def; } catch { return def; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } };

// État + actions d'une session Roto : ouverture sur la source active (cache persistant côté python :
// points + suivi restaurés), objets, points par frame, overlay de masque (data-URI), propagation
// complète OU partielle directionnelle, post-traitement non destructif, undo, preview, annulation.
// Toute la logique vit ici — RotoStudio ne fait que rendre.
export function useRotoSession(active: UpSource | null) {
  const [dims, setDims] = useState<{ w: number; h: number; frames: number } | null>(null);
  const [framesDir, setFramesDir] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [frame, setFrame] = useState(0);
  const [inF, setInF] = useState<number | null>(null);      // bornes de plage (I/O), null = tout
  const [outF, setOutF] = useState<number | null>(null);
  const [objects, setObjects] = useState<RotoObject[]>([{ id: 1, name: i18n.t("roto:object.name", { n: 1 }) }]);
  const [activeObj, setActiveObj] = useState(1);
  // Polarité du clic gauche : 1 = inclure (ajoute à l'objet), 0 = exclure (retire — aide SAM à
  // affiner). Le clic droit force TOUJOURS exclure ; ce toggle rend le point négatif découvrable.
  const [pointLabel, setPointLabel] = useState<0 | 1>(1);
  const [pointsByFrame, setPointsByFrame] = useState<Record<number, RotoPoint[]>>({});
  const [overlaySrc, setOverlaySrc] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);  // masque « et si » (survol Maj)
  const [showOverlay, setShowOverlay] = useState(true);
  const [overlayFull, setOverlayFull] = useState(false);   // rendu pleine image (matte/alpha/bgcolor)
  const [post, setPost] = useState<RotoPostState>(DEFAULT_POST);
  const [view, setView] = useState<RotoViewState>(DEFAULT_VIEW);
  const [tracked, setTracked] = useState(false);
  const [deduped, setDeduped] = useState(false);
  // Matte fin : `refined` = un alpha doux existe pour le suivi courant, `useRefined` = il fait foi
  // (viewer, export, suppression). Les deux sont distincts pour permettre la comparaison.
  const [refined, setRefined] = useState(false);
  const [useRefined, setUseRefined] = useState(true);
  const [matteParams, setMatteParams] = useState<RotoMatteParams>(DEFAULT_MATTE_PARAMS);
  const [work, setWork] = useState<string | null>(null);    // dossier de cache python (mattes /media)
  const [liveMatte, setLiveMatte] = useState<string | null>(null);  // matte union LIVE pendant le suivi
  const [testSrc, setTestSrc] = useState<string | null>(null);      // aperçu d'un test sur 1 image (après)
  const [testBefore, setTestBefore] = useState<string | null>(null);// image source (avant) → comparateur
  const [testLabel, setTestLabel] = useState<string | null>(null);
  // Mode d'affichage dans lequel l'aperçu de test a été rendu : c'est lui qui dit si l'image porte
  // une transparence à lire sur damier (`alpha`) ou si elle est opaque (édition, matte, fond).
  const [testMode, setTestMode] = useState<RotoViewMode | null>(null);
  // Point sélectionné (table OU glisser sur le viewer) : {frame, obj, index parmi l'objet}. Lueur + drag.
  const [selectedPoint, setSelectedPoint] = useState<{ f: number; obj: number; index: number } | null>(null);
  const [removeParams, setRemoveParams] = useState<RotoRemoveParams>(DEFAULT_REMOVE_PARAMS);
  const [busy, setBusy] = useState<string | null>(null);   // libellé de l'action en cours
  const [prog, setProg] = useState<RotoProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // `sam3.1` était l'id du Large avant qu'il soit recalé sur les poids réels (SAM 2.1, pas 3.1) : une
  // valeur restée en localStorage ne correspondrait plus à aucun modèle du registre.
  const [samModel, setSamModel] = useState(() => {
    const v = lsGet("nr.roto.sam", "sam2.1");
    return v === "sam3.1" ? "sam2.1-large" : v;
  });
  const [installedModels, setInstalledModels] = useState<string[]>([]);   // tous les ids de modèles installés
  const seqRef = useRef(0);      // ignore les réponses d'une source précédente
  const busyRef = useRef<string | null>(null);
  const workRef = useRef<string | null>(null);
  const framesDirRef = useRef<string | null>(null);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { workRef.current = work; }, [work]);
  useEffect(() => { framesDirRef.current = framesDir; }, [framesDir]);
  // Suivi live : chaque matte demandée porte un numéro croissant, et seule une matte PLUS RÉCENTE
  // que celle affichée remplace l'affichage. Comparer à la frame COURANTE ne marchait pas — à
  // ~7 images/s la suivante est demandée avant que la précédente ait fini de charger, donc chaque
  // chargement arrivait « périmé » et était jeté : le masque restait figé pendant tout le suivi.
  const liveSeq = useRef(0);
  const liveShownSeq = useRef(0);
  // Dossier des mattes que le travail en cours écrit : le suivi remplit `mattes/`, le matte fin
  // `mattes_refined/`. Câbler le chemin en dur montrerait l'ancien masque pendant tout l'affinage.
  const liveDirRef = useRef("mattes/union");
  const orderRef = useRef<number[]>([]);   // frames des points dans l'ordre de pose (undo local)
  const postTimer = useRef(0);
  const postSeq = useRef(0);
  // Nature de l'aperçu de test affiché : « refine » = alpha, donc rejouable avec un autre
  // post-traitement ; « remove » = image inpaintée, que la retouche du masque ne touche pas.
  const testKindRef = useRef<"refine" | "remove" | null>(null);
  const previewTimer = useRef(0);

  // Modèles réellement installés → n'afficher que ceux-là (SAM + moteurs matte/suppression).
  useEffect(() => {
    let on = true;
    nr.modelsList().then((r) => {
      if (!on || !r.ok) return;
      const inst = r.models.filter((m) => m.installed).map((m) => m.id);
      setInstalledModels(inst);
      const sam = new Set(SAM_MODELS.map((m) => m.id));
      const samInst = inst.filter((id) => sam.has(id));
      setSamModel((cur) => (samInst.includes(cur) ? cur : samInst[0] || cur));
    }).catch(() => {});
    return () => { on = false; };
  }, []);
  const installedSam = SAM_MODELS.filter((m) => installedModels.includes(m.id)).map((m) => m.id);

  const chooseSam = useCallback((id: string) => { lsSet("nr.roto.sam", id); setSamModel(id); }, []);

  // (Ré)ouvre la session quand la source active OU le modèle SAM change. Cache python : points et
  // suivi restaurés ; extraction en thread : dims tout de suite, frames corrigées par {extracted}.
  useEffect(() => {
    const seq = ++seqRef.current;
    setDims(null); setFramesDir(null); setFps(0); setFrame(0); setInF(null); setOutF(null);
    setPointsByFrame({}); setOverlaySrc(null); setPreviewSrc(null); setOverlayFull(false);
    setWork(null); setLiveMatte(null); setTestSrc(null); setTestBefore(null); setTestLabel(null);
    setTestMode(null); testKindRef.current = null;
    setSelectedPoint(null);
    setTracked(false); setDeduped(false); setRefined(false); setUseRefined(true);
    setErr(null); setNote(null); setPost(DEFAULT_POST); setView(DEFAULT_VIEW);
    setObjects([{ id: 1, name: i18n.t("roto:object.name", { n: 1 }) }]); setActiveObj(1);
    orderRef.current = [];
    if (!active) return;
    setBusy("Ouverture…");
    nr.rotoOpen({ video: active.path, in: active.in, out: active.out, model: samModel })
      .then((r) => {
        if (seqRef.current !== seq) return;
        if (!r.ok) { setErr(r.error || i18n.t("roto:errors.openFailed")); return; }
        const w = r.w || 0, h = r.h || 0;
        setDims({ w, h, frames: r.frames || 0 });
        setFps(r.fps || 0); setFramesDir(r.framesDir || null); setWork(r.work || null);
        if (r.cached) {
          // Session restaurée : points (px source → normalisés) + objets + suivi.
          const byFrame: Record<number, RotoPoint[]> = {};
          const objIds = new Set<number>([1]);
          for (const p of r.points || []) {
            (byFrame[p.frame] ||= []).push({ x: w ? p.x / w : 0, y: h ? p.y / h : 0, label: p.label, obj: p.obj });
            objIds.add(p.obj);
            orderRef.current.push(p.frame);
          }
          setPointsByFrame(byFrame);
          const names = r.names || {};
          setObjects([...objIds].sort((a, b) => a - b).map((id) => ({ id, name: names[String(id)] || i18n.t("roto:object.name", { n: id }) })));
          setTracked(!!r.tracked);
          setDeduped(!!r.deduped);
          setRefined(!!r.refined);
          if (r.points?.length || r.tracked) setNote(i18n.t("roto:note.restored"));
        }
      })
      .catch((e) => seqRef.current === seq && setErr(String(e)))
      .finally(() => seqRef.current === seq && setBusy(null));
  }, [active?.path, active?.in, active?.out, samModel]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Progression SSE : pct + fin d'extraction ({extracted} → vrai nb de frames) + suivi LIVE pendant
  // la propagation ({frame}) : le playhead suit ET la matte union tout juste écrite sur disque est
  // affichée par-dessus la frame (URL /media — zéro requête au daemon, occupé par le suivi).
  useEffect(() => nr.onRotoProgress((p) => {
    setProg(p);
    if (p.extracted) setDims((d) => (d ? { ...d, frames: p.extracted! } : d));
    const live = busyRef.current === "Suivi" || busyRef.current === "Matte fin";
    if (p.frame !== undefined && live && workRef.current) {
      const f = p.frame;
      setFrame(f);
      // La matte teintée d'avant le travail est PÉRIMÉE dès la première image suivie, et le daemon
      // est occupé — donc rien ne la rafraîchira. La laisser dessinée par-dessus la matte live
      // donnait un masque immobile au-dessus d'un suivi qui, lui, avançait.
      setOverlaySrc(null);
      // Précharge la matte tout juste écrite : on ne l'affiche QUE quand elle est décodée (sinon
      // fichier mid-write → flash blanc). La précédente reste visible jusque-là → suivi fluide.
      const seq = ++liveSeq.current;
      const url = nr.mediaUrl(`${workRef.current}/${liveDirRef.current}/${String(f).padStart(5, "0")}.png`) + `?v=${seq}`;
      const img = new Image();
      img.onload = () => {
        if (seq <= liveShownSeq.current) return;   // une matte plus récente est déjà affichée
        liveShownSeq.current = seq;
        setLiveMatte(url);
      };
      img.src = url;
    }
  }), []);

  // Scrub → overlay de la frame (points live ou mattes propagées). Sauté pendant une action longue
  // (le daemon est sériel : chaque rotoMask ferait la queue derrière la propagation).
  useEffect(() => {
    const seq = seqRef.current;
    if (busy) return;
    if (!dims || (!tracked && !pointsByFrame[frame]?.length)) { setOverlaySrc(null); setOverlayFull(false); return; }
    nr.rotoMask({ frame })
      .then((r) => {
        if (seqRef.current !== seq) return;
        setOverlaySrc(r.ok ? r.mask || null : null);
        setOverlayFull(!!(r.ok && r.full && r.mask));
      })
      .catch(() => {});
  }, [frame, dims, tracked, busy]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => setErr(String(e));

  // Pose un point (nx/ny normalisés 0..1 dans l'image) sur l'objet actif → overlay immédiat.
  const addPoint = useCallback(async (nx: number, ny: number, label: 0 | 1) => {
    if (!dims || busy) return;
    const pt: RotoPoint = { x: nx, y: ny, label, obj: activeObj };
    setPointsByFrame((m) => ({ ...m, [frame]: [...(m[frame] || []), pt] }));
    orderRef.current.push(frame);
    setErr(null); setNote(null); setPreviewSrc(null); setBusy("Segmentation…");
    try {
      const r = await nr.rotoAddPoint({ frame, x: nx * dims.w, y: ny * dims.h, label, obj: activeObj });
      if (r.ok) { setOverlaySrc(r.mask || null); setTracked(false); }
      else setErr(r.error || i18n.t("roto:errors.segmentFailed"));
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [dims, busy, frame, activeObj]);

  // Masque « et si je posais ce point ici ? » (survol Maj) — debounce 150 ms, jamais pendant busy.
  const previewPoint = useCallback((nx: number, ny: number, label: 0 | 1) => {
    if (!dims || busyRef.current) return;
    clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      if (busyRef.current) return;
      nr.rotoPreviewPoint({ frame, x: nx * dims.w, y: ny * dims.h, label, obj: activeObj })
        .then((r) => { if (r.ok) setPreviewSrc(r.mask || null); })
        .catch(() => {});
    }, 150);
  }, [dims, frame, activeObj]);
  const clearPreview = useCallback(() => { clearTimeout(previewTimer.current); setPreviewSrc(null); }, []);

  // Annule le DERNIER point posé (Ctrl+Z). Le BACKEND fait autorité : il dépile SON ordre de pose et
  // renvoie la frame du point retiré → on retire localement le dernier point de CETTE frame (aligné sur
  // le replay python). Plus de désync avec un orderRef local (effacements/retraits le corrompaient).
  const undoPoint = useCallback(async () => {
    if (busy) return;
    setBusy("Annulation…"); setErr(null);
    try {
      const r = await nr.rotoUndoPoint();
      if (!r.ok) { if (r.error && r.error !== "aucun point à annuler") setErr(r.error); return; }
      const f = r.frame;
      if (f !== undefined) {
        setPointsByFrame((m) => {
          const pts = (m[f] || []).slice(0, -1);
          const next = { ...m };
          if (pts.length) next[f] = pts; else delete next[f];
          return next;
        });
        const oi = orderRef.current.lastIndexOf(f);
        if (oi >= 0) orderRef.current.splice(oi, 1);
        if (f === frame) setOverlaySrc(r.mask || null);
      }
      setSelectedPoint(null); setTracked(false);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [busy, frame]);

  // Sélectionne un point (table/viewer) — lueur + cible du glisser. Efface via null.
  const selectPoint = useCallback((sel: { f: number; obj: number; index: number } | null) => setSelectedPoint(sel), []);

  // Déplace un point (glisser sur le viewer) : nouvelle position normalisée → backend rejoue, overlay MAJ.
  const movePoint = useCallback(async (f: number, obj: number, index: number, nx: number, ny: number) => {
    if (!dims || busy) return;
    setPointsByFrame((m) => {
      const all = m[f] || [];
      let seen = -1;
      const upd = all.map((p) => (p.obj === obj && ++seen === index ? { ...p, x: nx, y: ny } : p));
      return { ...m, [f]: upd };
    });
    setErr(null); setBusy("Segmentation…");
    try {
      const r = await nr.rotoMovePoint({ frame: f, obj, index, x: nx * dims.w, y: ny * dims.h });
      if (r.ok) { if (f === frame) setOverlaySrc(r.mask || null); setTracked(false); }
      else setErr(r.error || i18n.t("roto:errors.moveFailed"));
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [dims, busy, frame]);

  // Efface les points (frame courante / objet / tout) — le backend rejoue le reste.
  const clearPoints = useCallback(async (scope: { frame?: number; obj?: number }) => {
    setErr(null); setBusy("Recalcul…"); setSelectedPoint(null);
    setPointsByFrame((m) => {
      const next: Record<number, RotoPoint[]> = {};
      for (const [f, pts] of Object.entries(m)) {
        const keep = pts.filter((p) =>
          !((scope.frame === undefined || Number(f) === scope.frame) && (scope.obj === undefined || p.obj === scope.obj)));
        if (keep.length) next[Number(f)] = keep;
      }
      return next;
    });
    // Reconstruit l'ordre de pose (undo backend fait autorité, mais on garde orderRef cohérent).
    if (scope.frame !== undefined && scope.obj === undefined) {
      orderRef.current = orderRef.current.filter((f) => f !== scope.frame);
    }
    try {
      const r = await nr.rotoClearPoints(scope);
      if (r.ok) { setOverlaySrc(r.mask || null); setTracked(false); }
      else setErr(r.error || i18n.t("roto:errors.clearFailed"));
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, []);

  // Re-fetch de CE QUI EST À L'ÉCRAN après un changement de rendu (retouche du masque, mode
  // d'affichage) : le comparateur d'un test de matte fin quand il occupe le centre, l'overlay du
  // viewer sinon. Rafraîchir l'overlay SOUS le comparateur ne montrerait rien tout en coûtant un
  // rendu plein cadre par cran de slider ; `clearTest` le remet à jour à la fermeture.
  // `alive` jette une réponse dépassée : le daemon peut mettre plus longtemps que le debounce, et
  // l'image d'un réglage abandonné s'afficherait par-dessus celle du réglage courant.
  const refreshShown = useCallback((alive: () => boolean) => {
    if (busyRef.current || !alive()) return;
    if (testKindRef.current === "refine") {
      nr.rotoTestPreview().then((r) => {
        if (r.ok && r.preview && alive()) { setTestSrc(r.preview); setTestMode(r.mode ?? null); }
      }).catch(() => {});
      return;
    }
    if (testKindRef.current) return;
    nr.rotoMask({ frame }).then((r) => {
      if (r.ok && alive()) { setOverlaySrc(r.mask || null); setOverlayFull(!!(r.full && r.mask)); }
    }).catch(() => {});
  }, [frame]);

  // Post-traitement non destructif : push debouncé au backend, puis rafraîchissement de l'écran.
  const updatePost = useCallback((patch: Partial<RotoPostState>) => {
    const next = { ...post, ...patch };
    setPost(next);
    clearTimeout(postTimer.current);
    const seq = ++postSeq.current;
    postTimer.current = window.setTimeout(() => {
      nr.rotoSetPost(next)
        .then(() => refreshShown(() => seq === postSeq.current))
        .catch(() => {});
    }, 250);
  }, [frame, post, refreshShown]);

  const addObject = useCallback(() => {
    const id = Math.max(...objects.map((o) => o.id)) + 1;
    setActiveObj(id);
    setObjects([...objects, { id, name: i18n.t("roto:object.name", { n: id }) }]);
  }, [objects]);

  // Retire un objet = efface ses points partout (backend rejoue), puis le sort de la liste.
  const removeObject = useCallback((id: number) => {
    const next = objects.filter((o) => o.id !== id);
    if (!next.length) next.push({ id: 1, name: i18n.t("roto:object.name", { n: 1 }) });
    setObjects(next);
    if (activeObj === id) setActiveObj(next[0].id);
    void clearPoints({ obj: id });
  }, [activeObj, clearPoints, objects]);

  // Renommage : local immédiat + persistance debouncée côté python (points.json → survit au cache).
  const namesTimer = useRef(0);
  const renameObject = useCallback((id: number, name: string) => {
    const next = objects.map((o) => (o.id === id ? { ...o, name } : o));
    setObjects(next);
    clearTimeout(namesTimer.current);
    namesTimer.current = window.setTimeout(() => {
      void nr.rotoSetObjects({ names: Object.fromEntries(next.map((o) => [String(o.id), o.name])) }).catch(() => {});
    }, 400);
  }, [objects]);

  // Mode d'affichage (edit/matte/alpha/bgcolor + contours + fond). L'opacité est purement client
  // (CSS sur l'overlay) — pas d'aller-retour python. Le reste re-rend le masque courant.
  const updateView = useCallback((patch: Partial<RotoViewState>) => {
    setView((cur) => {
      const next = { ...cur, ...patch };
      const backend = patch.mode !== undefined || patch.outline !== undefined || patch.bg !== undefined;
      if (backend) {
        void nr.rotoSetView({ mode: next.mode, outline: next.outline, bg: next.bg })
          .then(() => refreshShown(() => true))
          .catch(() => {});
      }
      return next;
    });
  }, [refreshShown]);

  // Retire UN point précis (table des points) — le backend rejoue le reste.
  const removePoint = useCallback(async (f: number, obj: number, index: number) => {
    if (busy) return;
    setBusy("Recalcul…"); setErr(null);
    setPointsByFrame((m) => {
      const all = m[f] || [];
      // index = position parmi les points de CET objet sur la frame.
      let seen = -1;
      const keep = all.filter((p) => (p.obj === obj ? ++seen !== index : true));
      const next = { ...m };
      if (keep.length) next[f] = keep; else delete next[f];
      return next;
    });
    const oi = orderRef.current.lastIndexOf(f);
    if (oi >= 0) orderRef.current.splice(oi, 1);
    try {
      // Le suivi existant est CONSERVÉ : modifier les points n'efface pas les mattes.
      const r = await nr.rotoRemovePoint({ frame: f, obj, index });
      if (r.ok) { if (f === frame) setOverlaySrc(r.mask || null); }
      else setErr(r.error || i18n.t("roto:errors.removePointFailed"));
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [busy, frame]);

  // Actions longues (propagation, export, matte, suppression) — même gestion busy/erreur/note.
  const action = useCallback(async (
    fn: () => Promise<{ ok: boolean; error?: string; output?: string; frames?: number; canceled?: boolean; preview?: string }>,
    label: string, onOk?: (r: { output?: string; frames?: number; canceled?: boolean; preview?: string }) => void,
  ) => {
    setErr(null); setNote(null); setBusy(label); setProg(null);
    try {
      const r = await fn();
      if (r.ok) {
        setNote(r.canceled ? i18n.t("roto:note.canceled", { label })
          : r.output ? i18n.t("roto:note.output", { label, output: r.output }) : i18n.t("roto:note.done", { label }));
        onOk?.(r);
      } else setErr(r.error || i18n.t("roto:note.unavailable", { label }));
    } catch (e) { fail(e); } finally { setBusy(null); setProg(null); setLiveMatte(null); }
  }, []);

  // Suivi : all = complet (avant + arrière) ; forward/backward = re-propagation partielle depuis la
  // frame courante (correction locale, le reste du suivi est conservé). Borné in/out si posés.
  // `count` limite le nombre d'images propagées (pas-à-pas : 1 = une seule image).
  const track = useCallback((mode: "all" | "forward" | "backward" = "all", count?: number) => {
    useApp.getState().offerCloseForRam();
    return action(() => nr.rotoPropagate({
      mode, frame, inF: inF ?? undefined, outF: outF ?? undefined, count,
    }), "Suivi", () => { setTracked(true); setDeduped(false); setRefined(false); });
  }, [action, frame, inF, outF]);

  // Suivi pas-à-pas : propage UNE image dans la direction demandée puis avance le playhead dessus
  // (correction chirurgicale : on vérifie le masque image par image sans tout resuivre).
  const trackStep = useCallback((dir: 1 | -1) => {
    const target = frame + dir;
    return action(() => nr.rotoPropagate({
      mode: dir > 0 ? "forward" : "backward", frame,
      inF: inF ?? undefined, outF: outF ?? undefined, count: 1,
    }), "Suivi", () => { setTracked(true); setDeduped(false); setRefined(false); setFrame(target); });
  }, [action, frame, inF, outF]);

  // Efface le suivi (mattes) en gardant TOUS les points — repartir propre sans re-annoter.
  const clearTracking = useCallback(() =>
    action(async () => {
      const r = await nr.rotoClearTracking();
      return { ...r, output: undefined };
    }, "Réinitialisation du suivi", () => { setTracked(false); setDeduped(false); setRefined(false); setOverlaySrc(null); setOverlayFull(false); }),
  [action]);

  // Dédup animation : les frames quasi identiques (tenues) reçoivent la MÊME matte → contour stable.
  const dedupe = useCallback((threshold = 0.8) => {
    useApp.getState().offerCloseForRam();
    return action(async () => {
      const r = await nr.rotoDedupe({ threshold });
      return { ok: r.ok, error: r.error, output: r.ok ? i18n.t("roto:note.dedupeOutput", { groups: r.groups || 0, changed: r.changed || 0 }) : undefined };
    }, "Dédoublonnage", () => setDeduped(true));
  }, [action]);
  const dedupeRestore = useCallback(() =>
    action(() => nr.rotoDedupe({ restore: true }), "Restauration des mattes", () => setDeduped(false)), [action]);

  const cancel = useCallback(() => { void nr.rotoCancel().catch(() => {}); }, []);

  // Export : portée = union (obj undefined) ou UN objet ; bg = couleur du mode d'affichage.
  const exportAs = useCallback((format: string, obj?: number) => {
    useApp.getState().offerCloseForRam();
    return action(() => nr.rotoExport({ format, obj, bg: view.bg }), "Export");
  }, [action, view.bg]);
  // Matte fin : l'aperçu live vient de `mattes_refined/`, pas des mattes du suivi — le résultat est
  // visible image par image au lieu d'attendre la fin.
  const refine = useCallback((engine: string) => {
    useApp.getState().offerCloseForRam();
    liveDirRef.current = "mattes_refined/union";
    return action(() => nr.rotoRefine({ engine, ...matteParams }), "Matte fin", (r) => {
      if (r.canceled) return;
      setRefined(true);
      setUseRefined(true);
    }).finally(() => { liveDirRef.current = "mattes/union"; });
  }, [action, matteParams]);

  // Bascule affiné/brut : rien n'est recalculé, seule la source qui fait foi change côté python.
  const toggleRefined = useCallback(async (on: boolean) => {
    setUseRefined(on);
    try { await nr.rotoSetRefined({ on }); } catch (e) { fail(e); return; }
    if (busyRef.current) return;
    try {
      const r = await nr.rotoMask({ frame });
      if (r.ok) { setOverlaySrc(r.mask || null); setOverlayFull(!!(r.full && r.mask)); }
    } catch { /* l'overlay se rafraîchira au prochain scrub */ }
  }, [frame]);
  const removeSelected = useCallback((engine: string) => {
    useApp.getState().offerCloseForRam();
    return action(() => nr.rotoObjectRemove({ engine, ...removeParams }), "Suppression");
  }, [action, removeParams]);

  // TEST sur l'image courante : le moteur tourne sur cette seule image (fenêtre courte pour la
  // suppression — contexte temporel du modèle vidéo) et renvoie un aperçu, RIEN n'est écrit.
  // Capture l'aperçu (après) ET l'image source (avant, /media) de la frame testée → comparateur.
  const onPreview = useCallback((kind: "refine" | "remove", label: string, beforeFrame: number) =>
    (r: { preview?: string; mode?: RotoViewMode }) => {
      if (r.preview) {
        testKindRef.current = kind;
        // Une suppression d'objet rend une image inpaintée OPAQUE : pas de mode d'affichage, donc
        // pas de damier — le matte fin, lui, sort dans la vue courante.
        setTestMode(kind === "refine" ? (r.mode ?? "edit") : null);
        setTestSrc(r.preview); setTestLabel(label); setNote(null);
        setTestBefore(framesDirRef.current
          ? nr.mediaUrl(`${framesDirRef.current}/${String(beforeFrame).padStart(5, "0")}.jpg`) : null);
      }
    }, []);
  const testRefine = useCallback((engine: string) =>
    action(() => nr.rotoRefine({ engine, warmup: matteParams.warmup, maxSize: matteParams.maxSize, frame }),
      "Test matte (1 image)",
      onPreview("refine", i18n.t("roto:test.matteImage", { n: frame + 1 }), frame)),
    [action, frame, matteParams.maxSize, matteParams.warmup, onPreview]);
  const testRemove = useCallback((engine: string) =>
    action(() => nr.rotoObjectRemove({ engine, ...removeParams, frame }), "Test suppression (1 image)",
      onPreview("remove", i18n.t("roto:test.removeImage", { n: frame + 1 }), frame)), [action, frame, removeParams, onPreview]);
  // Fermeture du comparateur : le viewer reprend la place, avec un overlay qui peut dater d'avant
  // les retouches faites pendant que le test l'occupait.
  const clearTest = useCallback(() => {
    setTestSrc(null); setTestBefore(null); setTestLabel(null); setTestMode(null);
    testKindRef.current = null;
    if (busyRef.current) return;
    nr.rotoMask({ frame }).then((r) => {
      if (r.ok) { setOverlaySrc(r.mask || null); setOverlayFull(!!(r.full && r.mask)); }
    }).catch(() => {});
  }, [frame]);

  return {
    dims, framesDir, fps, frame, setFrame,
    inF, outF, setInF, setOutF,
    samModel, chooseSam, installedSam, installedModels,
    selectedPoint, selectPoint, movePoint,
    objects, activeObj, setActiveObj, addObject, removeObject, renameObject,
    pointLabel, setPointLabel,
    points: pointsByFrame[frame] || [], pointsByFrame,
    pointCount: Object.values(pointsByFrame).reduce((n, p) => n + p.length, 0),
    overlaySrc: showOverlay ? overlaySrc : null,
    previewSrc: showOverlay ? previewSrc : null,
    overlayFull,
    showOverlay, setShowOverlay,
    post, updatePost,
    view, updateView,
    tracked, busy, prog, err, note,
    liveMatte, testSrc, testBefore, testLabel, testMode, clearTest,
    removeParams, setRemoveParams,
    matteParams, setMatteParams, refined, useRefined, toggleRefined,
    addPoint, previewPoint, clearPreview, undoPoint, clearPoints, removePoint,
    track, trackStep, clearTracking, dedupe, dedupeRestore, deduped,
    cancel, exportAs, refine, removeSelected, testRefine, testRemove,
  };
}

export type RotoSession = ReturnType<typeof useRotoSession>;
