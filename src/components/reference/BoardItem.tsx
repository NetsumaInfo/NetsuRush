// Un item posé sur le board : wrapper positionné (translate + rotate + taille), contenu média ou
// note texte, et — quand sélectionné seul — 8 poignées de redimensionnement + 1 poignée de rotation.
// Gestes via usePointerTransform (capture sur le wrapper). Multi-sélection (Shift) → déplacement de
// groupe au relâchement. Notes texte éditables (double-clic). Miroir (flipH/flipV) sur le contenu.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, FileQuestion, FolderSearch, Loader2, ImageOff, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { nr, nextProxyToken } from "@/lib/bridge";
import { type BoardItem as Item, type BoardLink, parseVideoEmbed, EMBED_PLAYER_PROVIDERS, displaySrc, isRemoteRef } from "./referenceShared";
import { recoverMedia, relocateMissingMedia } from "./boardMediaActions";
import { usePointerTransform, type ResizeHandle } from "./usePointerTransform";
import { useBoard } from "./useReferenceBoard";
import { registerPlayer } from "./playhead";
import { shapeBBox, shifted } from "./drawGeometry";
import { YoutubeItem } from "./YoutubeItem";
import { EmbedItem } from "./EmbedItem";

// Récupération auto d'un média cassé/noir (lien distant mort ou média extrait d'un post) : une seule
// tentative par item (anti-boucle), uniquement si un lien d'origine existe (sourceUrl ou ref http).
const recoverAttempted = new Set<string>();
function recoverableLink(it: Item): boolean {
  return !!(it.sourceUrl || /^https?:/i.test(it.ref));
}
function triggerRecover(it: Item) {
  if (!recoverableLink(it) || recoverAttempted.has(it.id)) return;
  recoverAttempted.add(it.id);
  void recoverMedia(it.id);
}

// Séquence d'images : taille du bloc de préchargement (frames gardées décodées en avance).
const PRELOAD_BLOCK = 24;
// Pas minimal entre deux reculs d'une vidéo en aller-retour (cf. la boucle ping-pong).
const BACKSTEP_MS = 66;

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_POS: Record<ResizeHandle, string> = {
  nw: "-top-1 -left-1 cursor-nwse-resize", n: "-top-1 left-1/2 -translate-x-1/2 cursor-ns-resize",
  ne: "-top-1 -right-1 cursor-nesw-resize", e: "top-1/2 -right-1 -translate-y-1/2 cursor-ew-resize",
  se: "-bottom-1 -right-1 cursor-nwse-resize", s: "-bottom-1 left-1/2 -translate-x-1/2 cursor-ns-resize",
  sw: "-bottom-1 -left-1 cursor-nesw-resize", w: "top-1/2 -left-1 -translate-y-1/2 cursor-ew-resize",
};

// Vidéo qui boucle sur [trimIn, trimOut] si défini, sinon boucle entière. `streamSrc` force la
// source (flux YouTube relayé par le core) : pas de proxy dans ce cas, et une erreur de lecture
// remonte à l'appelant au lieu de déclencher la récupération de média. `onNatSize` reports the
// decoded dimensions — the only place a relayed stream states its true ratio.
function VideoContent({ item, streamSrc, onStreamError, onNatSize }: {
  item: Item;
  streamSrc?: string;
  onStreamError?: () => void;
  onNatSize?: (w: number, h: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const patchItem = useBoard((s) => s.patchItem);
  const mediaSuspended = useBoard((s) => s.frozen || (s.navigating && s.prefs.pauseMediaWhileNavigating));
  // Portée de boucle valide seulement si out > in (sinon on ignore le out pour éviter un seek en boucle).
  const trimIn = item.trimIn && item.trimIn > 0 ? item.trimIn : 0;
  const trimOut = item.trimOut != null && item.trimOut > trimIn ? item.trimOut : null;
  // Mode de lecture : "off" ne joue jamais (figé), "pingpong" aller-retour, "loop" (défaut) boucle.
  const playMode = item.playMode ?? "loop";
  const playing = !mediaSuspended && playMode !== "off";

  // Un CUT d'un fichier LOCAL (souvent MKV/HEVC : <video> ne lit pas le conteneur Matroska et le seek
  // mid-file échoue sur /stream copy → on voyait le DÉBUT du fichier, pas le plan) → on lit un PROXY
  // mp4 court de la portée exacte, comme l'aperçu du MediaPicker. Régénéré à chaque montage (cache
  // serveur → quasi instantané) ; survit donc au reload sans persister d'URL tmp.
  const localRef = !isRemoteRef(item.ref);
  const useProxy = !streamSrc && trimOut != null && localRef;
  const [proxUrl, setProxUrl] = useState<string | null>(null);

  // Encode le proxy dès le montage (le core throttle déjà les encodes concurrents via proxyGate →
  // pas besoin de gater côté UI ; un gate de visibilité empêchait la lecture de démarrer).
  useEffect(() => {
    if (!useProxy) { setProxUrl(null); return; }
    let alive = true;
    const token = nextProxyToken();
    nr.proxy({ input: item.ref, start: trimIn, end: trimOut!, priority: "high", height: Math.round(item.h || 240), token, requireVideo: true })
      .then((r) => { if (alive && r.ok && r.path) setProxUrl(nr.assetUrl(r.path)); });
    return () => { alive = false; nr.proxyCancel(token); };
  }, [useProxy, item.ref, item.h, trimIn, trimOut]);

  // Lecture / gel global — ne joue QUE si l'item n'est pas figé. Le ping-pong est piloté par l'effet
  // rAF dédié ci-dessous (lecture native seulement en mode boucle).
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!playing) v.pause();
    else if (playMode !== "pingpong") v.play().catch(() => {});
  }, [playing, playMode, proxUrl]);

  // Ping-pong : aller-retour sur [lo, hi]. <video> ne lit pas en arrière → avant = lecture native
  // (fluide), arrière = pas manuel de currentTime en rAF. Proxy = segment exact ([0, durée]).
  useEffect(() => {
    const v = ref.current;
    if (!v || !playing || playMode !== "pingpong") return;
    const lo = useProxy ? 0 : trimIn;
    let raf = 0, prev = 0, back = 0, dir: 1 | -1 = 1;
    const tick = (ts: number) => {
      const dt = prev ? (ts - prev) / 1000 : 0;
      prev = ts;
      const hi = useProxy ? v.duration || 0 : trimOut ?? v.duration ?? 0;
      if (dir === 1) {
        if (v.paused) v.play().catch(() => {});
        if (hi && v.currentTime >= hi) { dir = -1; v.pause(); back = 0; }
      } else {
        if (!v.paused) v.pause();
        // Marche arrière : écrire `currentTime` force un décodage depuis la keyframe précédente, bien
        // plus cher qu'une lecture normale. À la cadence de l'écran, N items en aller-retour font N
        // seeks à chaque frame — sur un board qui en porte des dizaines, le décodeur ne suit plus.
        // Un pas toutes les BACKSTEP_MS donne le même rendu à l'œil pour une fraction du coût.
        back += dt * 1000;
        if (back >= BACKSTEP_MS) {
          const next = v.currentTime - back / 1000;
          back = 0;
          if (next <= lo) { v.currentTime = lo; dir = 1; } else v.currentTime = next;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, playMode, useProxy, trimIn, trimOut, proxUrl]);

  // Publishes the playback position to the inspector (loop playhead) and takes its scrub seeks. The
  // proxy plays the cut segment alone, so its clock is offset by trimIn — the offset is read from a
  // ref, not captured, so a bound dragged live never seeks against a stale base.
  const baseRef = useRef(0);
  baseRef.current = useProxy ? trimIn : 0;
  useEffect(
    () =>
      registerPlayer(item.id, {
        time: () => (ref.current ? baseRef.current + ref.current.currentTime : null),
        seek: (t) => {
          const v = ref.current;
          if (v) v.currentTime = Math.max(0, t - baseRef.current);
        },
      }),
    [item.id],
  );

  // Proxy = segment déjà découpé → boucle entière, aucun seek. Sinon (fichier natif lisible) on garde
  // le seek [trimIn, trimOut] sur la source brute (/media supporte le Range).
  const seekIn = () => {
    if (useProxy) return;
    const v = ref.current;
    if (v && trimIn && Math.abs(v.currentTime - trimIn) > 0.05) v.currentTime = trimIn;
  };
  useEffect(seekIn, [trimIn, useProxy]);

  const src = streamSrc ?? (useProxy ? proxUrl : item.src);
  const video = (
    <video
      ref={ref}
      src={src ?? undefined}
      muted
      loop={playMode === "loop" && (useProxy || trimOut == null)}
      autoPlay={playing && playMode !== "pingpong"}
      playsInline
      className={item.crop ? "block select-none" : "block h-full w-full select-none object-cover"}
      style={item.crop ? cropStyle(item.crop) : undefined}
      onError={() => { if (onStreamError) onStreamError(); else triggerRecover(item); }}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        // chargé mais noir → récupère (ou, pour un flux relayé, repli sur le lecteur intégré)
        if (!useProxy && !e.currentTarget.videoWidth) { if (onStreamError) onStreamError(); else triggerRecover(item); }
        // A proxy is a re-encoded excerpt: its dimensions are the proxy's, not the source's.
        if (!useProxy && e.currentTarget.videoWidth && e.currentTarget.videoHeight) {
          onNatSize?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
        }
        if (!useProxy && d && isFinite(d) && Math.abs(d - (item.dur ?? 0)) > 0.5) patchItem(item.id, { dur: d }, false);
        seekIn();
      }}
      onTimeUpdate={(e) => {
        if (useProxy || playMode !== "loop") return;
        const v = e.currentTarget;
        if (trimOut != null && v.currentTime >= trimOut) v.currentTime = trimIn;
      }}
    >
      <track kind="captions" />
    </video>
  );
  return item.crop ? <div className="relative h-full w-full overflow-hidden">{video}</div> : video;
}

// Séquence d'images : affiche frames[frame] ; avance auto en boucle quand `seqPlay`
// et que le board n'est pas figé. L'avance écrit la frame via setSeqFrame (sans dirty → pas de spam
// d'autosave). La barre de contrôle (SequencePlayer) ne fait que piloter seqPlay/frame.
function SequenceContent({ item }: { item: Item }) {
  const mediaSuspended = useBoard((s) => s.frozen || (s.navigating && s.prefs.pauseMediaWhileNavigating));
  const setSeqFrame = useBoard((s) => s.setSeqFrame);
  const commitSeqFrame = useBoard((s) => s.commitSeqFrame);
  const patchItem = useBoard((s) => s.patchItem);
  const frames = useMemo(() => item.frames ?? [], [item.frames]);
  const count = frames.length;
  // Frame vivante d'abord (hors document, cf. `seqFrames`) : ce sélecteur ne rend qu'un nombre, donc
  // la séquence voisine qui avance ne re-rend pas celle-ci.
  const liveFrame = useBoard((s) => s.seqFrames[item.id]);
  const cur = Math.min(Math.max(liveFrame ?? item.frame ?? 0, 0), Math.max(0, count - 1));
  const playing = (item.seqPlay ?? true) && !mediaSuspended; // défaut = lecture (autoplay au retour sur le board)
  const dirRef = useRef<1 | -1>(1);  // sens courant en mode aller-retour
  const posRef = useRef(0);          // position FLOTTANTE (frame fractionnaire) pour un pacing fluide

  // Précharge une FENÊTRE glissante autour de la frame courante (ignore les manquantes) → pas de flash
  // au changement, sans garder toute la séquence décodée en mémoire (600 frames × N items sur le board
  // saturaient la RAM). Découpée en blocs : l'effet ne se relance qu'un tour de bloc sur PRELOAD_BLOCK.
  const block = Math.floor(cur / PRELOAD_BLOCK);
  useEffect(() => {
    const from = block * PRELOAD_BLOCK;
    const imgs = frames.slice(from, from + PRELOAD_BLOCK * 2).filter(Boolean)
      .map((f) => { const im = new Image(); im.src = displaySrc("image", f); return im; });
    return () => { imgs.forEach((im) => { im.src = ""; }); };
  }, [frames, block]);

  // Avance auto pilotée par rAF + temps RÉEL (Δt) → pacing fluide indépendant de la cadence d'écran et
  // sans dérive (un setInterval saccadait). La position vit en flottant ; on n'écrit la frame entière au
  // store QUE quand elle change (re-render minimal). Reste dans [seqIn, seqOut] et suit le type de boucle
  // (playMode) : loop / aller-retour / une fois. fps×speed lus LIVE → la vitesse change sans relancer.
  useEffect(() => {
    if (!playing || count < 2) return;
    let raf = 0, prev = 0;
    posRef.current = item.frame ?? 0;
    const step = (ts: number) => {
      if (!prev) prev = ts;
      const dt = (ts - prev) / 1000;
      prev = ts;
      const st = useBoard.getState();
      const it = st.items.find((i) => i.id === item.id);
      if (!it) { raf = requestAnimationFrame(step); return; }
      const lo = Math.min(Math.max(it.seqIn ?? 0, 0), count - 1);
      const hi = Math.min(Math.max(it.seqOut ?? count - 1, lo), count - 1);
      const mode = it.playMode ?? "loop";
      const rate = Math.max(0.1, (it.fps ?? 12) * (it.speed ?? 1)); // frames/s
      const span = hi - lo + 1;
      let pos = posRef.current;
      if (pos < lo || pos > hi + 1) pos = lo;
      if (mode === "pingpong" && span > 1) {
        pos += dirRef.current * rate * dt;
        if (pos >= hi) { pos = hi; dirRef.current = -1; }
        else if (pos <= lo) { pos = lo; dirRef.current = 1; }
      } else if (mode === "off") {
        pos += rate * dt;
        if (pos >= hi) { posRef.current = hi; commitSeqFrame(item.id, hi); patchItem(item.id, { seqPlay: false }, false); return; }
      } else {
        pos += rate * dt;
        if (span > 0 && pos >= lo + span) pos = lo + ((pos - lo) % span); // boucle
      }
      posRef.current = pos;
      const idx = Math.min(hi, Math.max(lo, Math.floor(pos)));
      if (idx !== (st.seqFrames[item.id] ?? it.frame ?? -1)) setSeqFrame(item.id, idx);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Fin de lecture (pause, gel, démontage) → la dernière position rejoint le DOCUMENT : la scène se
    // rouvre là où on l'a laissée, et l'entrée vivante disparaît (sinon elle masquerait `item.frame`).
    return () => {
      cancelAnimationFrame(raf);
      const live = useBoard.getState().seqFrames[item.id];
      if (live != null) commitSeqFrame(item.id, live);
    };
    // item.frame exclu volontairement : il est ÉCRIT par cet effet (sinon relance à chaque frame).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, count, item.id, setSeqFrame, commitSeqFrame, patchItem]);

  // Aucune frame, OU frame courante manquante (importée d'un .netsu sans le fichier) → placeholder.
  if (!count || !frames[cur]) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground">
        <ImageOff className="size-8" strokeWidth={1.5} />
      </div>
    );
  }
  const img = (
    <img
      src={displaySrc("image", frames[cur])}
      alt={item.title ?? ""}
      draggable={false}
      className={item.crop ? "block select-none" : "block h-full w-full select-none object-cover"}
      style={item.crop ? cropStyle(item.crop) : undefined}
    />
  );
  return item.crop ? <div className="relative h-full w-full overflow-hidden">{img}</div> : img;
}

// Ouvre le lien d'une note : URL (navigateur), fichier (app système), ou item du board (caméra).
function openNoteLink(link: BoardLink) {
  if (link.kind === "url") void nr.openExternal(link.target);
  else if (link.kind === "file") void nr.openPath(link.target);
  else useBoard.getState().requestFocus(link.target);
}

function TextNote({ item, editing }: { item: Item; editing: boolean }) {
  const { t } = useTranslation("reference");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const patchItem = useBoard((s) => s.patchItem);
  const updateItem = useBoard((s) => s.updateItem);
  const setEditing = useBoard((s) => s.setEditing);
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  // AUTO-HAUTEUR en édition : la note grandit quand le texte déborde (plus de texte coupé en tapant).
  // Mesures en px CSS = unités MONDE (le scale visuel ne change pas le layout) ; record=false (ajustement
  // auto, pas une action utilisateur). Ne rétrécit jamais toute seule (la taille reste à l'utilisateur).
  // GARDE anti-boucle : une seule croissance par hauteur de contenu (`scrollHeight`) — si la hauteur
  // du wrapper ne suit pas (edge case), on ne re-tente pas → jamais de setState infini.
  const grownAt = useRef(0);
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    const need = ta.scrollHeight - ta.clientHeight;
    if (need > 1 && grownAt.current !== ta.scrollHeight) {
      grownAt.current = ta.scrollHeight;
      updateItem(item.id, { h: item.h + need }, false);
    }
  }, [editing, item.text, item.fontSize, item.lineHeight, item.h, item.id, updateItem]);

  // Décorations cumulables (souligné + barré) → liste d'espace-séparée.
  const deco = [item.underline && "underline", item.strike && "line-through"].filter(Boolean).join(" ");
  const style: React.CSSProperties = {
    fontSize: item.fontSize ?? 18,
    fontFamily: item.fontFamily,
    color: item.color ?? "#1f2937",
    textAlign: item.align ?? "left",
    fontWeight: item.bold ? 700 : 400,
    fontStyle: item.italic ? "italic" : "normal",
    textDecoration: deco || "none",
    lineHeight: item.lineHeight ?? 1.2,
    paddingLeft: item.indent ? item.indent * 24 + 12 : undefined, // retrait (palier 24px) + p-3 de base
  };

  if (editing) {
    // Commit LIVE (onChange) : le texte est toujours sauvé, quel que soit le mode de sortie d'édition
    // (blur, clic ailleurs, Échap) — pas de perte si le blur ne se déclenche pas.
    return (
      <textarea
        aria-label={item.title || item.text || "Note"}
        ref={taRef}
        value={item.text ?? ""}
        onChange={(e) => patchItem(item.id, { text: e.target.value })}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          // Rester en édition si le focus part vers la barre de style de la note (permet de changer
          // police/taille/couleur en pleine frappe). Sinon (clic sur le board, Échap) → on sort.
          const next = e.relatedTarget as HTMLElement | null;
          if (next?.closest?.("[data-note-toolbar]")) return;
          setEditing(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") { setEditing(null); return; }
          const mod = e.ctrlKey || e.metaKey;
          const k = e.key.toLowerCase();
          // Styles au clavier pendant la frappe (portée = toute la note, comme l'inspecteur).
          if (mod && k === "b") { e.preventDefault(); patchItem(item.id, { bold: !item.bold }); return; }
          if (mod && k === "i") { e.preventDefault(); patchItem(item.id, { italic: !item.italic }); return; }
          if (mod && k === "u") { e.preventDefault(); patchItem(item.id, { underline: !item.underline }); return; }
          // Tab / Maj+Tab = retrait (au lieu de voler le focus).
          if (e.key === "Tab") {
            e.preventDefault();
            const ind = item.indent ?? 0;
            patchItem(item.id, { indent: e.shiftKey ? Math.max(0, ind - 1) : Math.min(8, ind + 1) });
            return;
          }
          // Entrée dans une liste : continue la puce / le numéro sur la nouvelle ligne.
          if (e.key === "Enter" && (item.bullet || item.numbered)) {
            e.preventDefault();
            const ta = e.currentTarget;
            const { selectionStart: s0, selectionEnd: s1, value } = ta;
            const line = value.slice(0, s0).slice(value.slice(0, s0).lastIndexOf("\n") + 1);
            const m = item.numbered ? line.match(/^(\d+)\.\s/) : null;
            const prefix = item.numbered ? `${m ? Number(m[1]) + 1 : 1}. ` : "• ";
            patchItem(item.id, { text: value.slice(0, s0) + "\n" + prefix + value.slice(s1) });
            const pos = s0 + 1 + prefix.length;
            requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = pos; });
          }
        }}
        className="h-full w-full resize-none bg-transparent p-3 outline-none"
        style={style}
      />
    );
  }
  // Surlignage = fond DERRIÈRE les glyphes (distinct du fond de note `bg`) ; box-decoration-break
  // pour qu'il épouse chaque ligne du texte multi-lignes.
  const hl = item.highlight && item.highlight !== "transparent";
  return (
    <div className="relative h-full w-full overflow-hidden whitespace-pre-wrap break-words p-3" style={style}>
      {item.text ? (
        hl ? (
          <span style={{ background: item.highlight, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone", padding: "0.05em 0.15em" }}>
            {item.text}
          </span>
        ) : (
          item.text
        )
      ) : (
        <span className="text-muted-foreground">{t("item.doubleClickEdit")}</span>
      )}
      {item.link && (
        <button type="button"
          aria-label={t("actions.openLink")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); openNoteLink(item.link!); }}
          className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow ring-1 ring-black/10 transition-colors hover:bg-primary [&_svg]:size-3"
        >
          <Link2 />
        </button>
      )}
    </div>
  );
}

// Style de rognage : l'élément média (taille 1/crop) translaté pour ne montrer que la région crop.
function cropStyle(c: NonNullable<Item["crop"]>): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    width: `${100 / c.w}%`,
    height: `${100 / c.h}%`,
    transform: `translate(${-c.x * 100}%, ${-c.y * 100}%)`,
    objectFit: "fill",
  };
}

// Cadre (conteneur titré) : rectangle dont le CONTOUR prend la couleur choisie + titre en haut-gauche.
// Déplacer le cadre déplace les items qu'il contient (cf. commit de déplacement plus bas).
function FrameContent({ item }: { item: Item }) {
  const { t } = useTranslation("reference");
  const color = item.color ?? "#8b8b94";
  // Remplissage : "none" → contour seul (intérieur transparent) ; "tint" → léger aplat teinté
  // (défaut) ; "solid" → couleur opaque. `filled` legacy → "solid".
  const fillMode = item.fillMode ?? (item.filled ? "solid" : "tint");
  const background =
    fillMode === "solid" ? item.fillColor ?? color
    : fillMode === "none" ? "transparent"
    : `color-mix(in srgb, ${color} 9%, transparent)`;
  // Style mood-board : panneau de section discret + fin contour coloré + étiquette de
  // titre posée AU-DESSUS du bord haut (comme un onglet de groupe).
  return (
    <div
      className="relative h-full w-full rounded-lg"
      style={{
        border: `1.5px solid color-mix(in srgb, ${color} 70%, transparent)`,
        background,
      }}
    >
      <span
        className="absolute -top-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded px-2 py-0.5 font-medium leading-tight"
        style={{ color, background: item.titleBg ?? "var(--color-surface)", fontSize: item.fontSize ?? 14, fontFamily: item.fontFamily }}
      >
        {item.text || t("item.frameDefault")}
      </span>
    </div>
  );
}

// Octets → libellé court (Ko/Mo/Go).
function humanSize(n: number): string {
  if (!n) return "";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// Placeholder d'un média MANQUANT après import d'un .netsu (gros fichier référencé non retrouvé) :
// invite à relocaliser le fichier sur la machine locale → repointe `ref` et efface `missing`.
function MissingContent({ item }: { item: Item }) {
  const { t } = useTranslation("reference");
  const patchItem = useBoard((s) => s.patchItem);
  // Compté sans allouer : ce sélecteur retourne un NOMBRE, donc il ne réveille son composant que
  // lorsque le compte change (un `filter().length` recrée un tableau à chaque commit du store).
  const missingCount = useBoard((s) => s.items.reduce((n, i) => (i.missing && i.kind !== "sequence" ? n + 1 : n), 0));
  const relocate = async () => {
    // Séquence : re-choix multi-images → reconstruit `frames` (ordre de sélection).
    if (item.kind === "sequence") {
      const paths = await nr.chooseImages();
      if (!paths?.length) return;
      patchItem(item.id, { frames: paths, ref: paths[0], frame: 0, missing: undefined });
      return;
    }
    const paths = item.missing?.kind === "image" ? await nr.chooseImages() : await nr.chooseFiles();
    const p = paths?.[0];
    if (!p) return;
    patchItem(item.id, { ref: p, src: displaySrc(item.kind, p), missing: undefined });
  };
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/30 p-3 text-center">
      <FileQuestion className="size-7 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <p className="line-clamp-2 text-xs font-medium text-foreground break-all">{item.missing?.name || t("item.missingMedia")}</p>
      {!!item.missing?.size && <p className="text-[10px] text-muted-foreground">{t("item.notBundled", { size: humanSize(item.missing.size) })}</p>}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void relocate()}
        className="mt-1 inline-flex items-center gap-1.5 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        <FolderSearch className="size-3.5" /> {t("item.relocate")}
      </button>
      {/* Un board reçu arrive rarement avec UN seul trou : proposer le dossier entier depuis la
          première tuile évite de répéter le même geste autant de fois qu'il y a de rushs. */}
      {missingCount > 1 && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void relocateMissingMedia()}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {t("item.relocateAll", { count: missingCount })}
        </button>
      )}
    </div>
  );
}

// Placeholder pendant le téléchargement/extraction d'un lien : carré sombre + loader animé.
function LoadingContent({ item }: { item: Item }) {
  const { t } = useTranslation("reference");
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2.5 bg-muted/40 text-muted-foreground">
      <Loader2 className="size-8 animate-spin" strokeWidth={1.5} />
      <span className="max-w-[85%] truncate text-xs font-medium">{item.title ?? t("item.downloading")}</span>
    </div>
  );
}

// Image fixe — ou ANIMÉE (GIF, WebP animé : l'ingestion Giphy en pose beaucoup). Un `<img>` animé ne
// s'arrête jamais : ni « Tout figer », ni la pause pendant la navigation ne l'atteignent, et un board
// qui en porte des dizaines décode en permanence sans que le bouton de gel n'y change rien. Sous gel,
// on peint donc la frame courante dans un <canvas> et on montre celui-ci.
//
// Le gel TRANSITOIRE (pan/zoom) est volontairement ignoré : basculer <img>/<canvas> à chaque geste
// coûterait plus que ce qu'il économise. Seul le gel EXPLICITE, celui que l'utilisateur a demandé,
// arrête l'animation. Dessiner une image d'une autre origine (Giphy) teinte le canvas — sans
// importance, on l'affiche, on n'en relit jamais les pixels.
const ANIMATED_IMAGE_RE = /\.(gif|webp|avif|apng)(?:$|[?#])/i;

function ImageContent({ item }: { item: Item }) {
  const frozen = useBoard((s) => s.frozen);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animated = ANIMATED_IMAGE_RE.test(item.src ?? "");
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!animated || !frozen) { setPainted(false); return; }
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.naturalWidth) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    try {
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      setPainted(true);
    } catch { /* peinture refusée : on laisse le <img> animé plutôt qu'un carré vide */ }
  }, [animated, frozen, item.src]);

  const onErr = () => triggerRecover(item);
  const onLd = (e: React.SyntheticEvent<HTMLImageElement>) => { if (!e.currentTarget.naturalWidth) triggerRecover(item); };
  const cls = item.crop ? "block select-none" : "block h-full w-full select-none object-cover";
  const style = item.crop ? cropStyle(item.crop) : undefined;
  const media = (
    <>
      <img
        ref={imgRef} src={item.src} alt={item.title ?? ""} draggable={false}
        onError={onErr} onLoad={onLd} className={cls} style={{ ...style, ...(painted ? { display: "none" } : null) }}
      />
      {animated && <canvas ref={canvasRef} aria-hidden className={cls} style={{ ...style, ...(painted ? null : { display: "none" }) }} />}
    </>
  );
  return item.crop ? <div className="relative h-full w-full overflow-hidden">{media}</div> : media;
}

// YouTube joué comme une vidéo ordinaire : le flux est relayé par le core (yt-dlp le résout), donc
// plus d'iframe — ni gros bouton lecture au rebouclage, ni écran de fin, et le trim/ping-pong sont
// ceux d'une vidéo locale. Repli sur le lecteur intégré si le relais échoue (vidéo privée, restreinte,
// yt-dlp absent) : son habillage vaut mieux qu'un carré noir.
function YoutubeContent({ item, live, onFallback }: { item: Item; live: boolean; onFallback: (on: boolean) => void }) {
  const [embedded, setEmbedded] = useState(false);
  const patchItem = useBoard((s) => s.patchItem);
  // Nouvelle vidéo sur le même item → on retente le flux direct.
  useEffect(() => { setEmbedded(false); onFallback(false); }, [item.ref, onFallback]);

  // A YouTube card is posed before anything is known of the video — 16:9, or 9:16 when the link says
  // `/shorts/`. The relayed stream is where the TRUE ratio finally shows up (a Short shared as a
  // plain `watch?v=` link is landscape until here), so the card is reshaped around its own centre at
  // constant area: a vertical video stops being cropped inside a landscape box. Runs at most once
  // per ratio — the geometry then matches, and resizing keeps the aspect locked. A cropped item is
  // left alone: its box deliberately differs from the source ratio.
  const fitNatSize = useCallback((vw: number, vh: number) => {
    const it = useBoard.getState().items.find((i) => i.id === item.id);
    if (!it) return;
    const patch: Partial<Item> = {};
    if (it.natW !== vw || it.natH !== vh) { patch.natW = vw; patch.natH = vh; }
    const ratio = vw / vh;
    if (!it.crop && it.w > 0 && it.h > 0 && Math.abs(it.w / it.h - ratio) > 0.01) {
      const w = Math.round(Math.sqrt(it.w * it.h * ratio));
      const h = Math.round(w / ratio);
      Object.assign(patch, { w, h, x: it.x + (it.w - w) / 2, y: it.y + (it.h - h) / 2 });
    }
    // `record: false` — a measurement is not a user edit, it must not eat an undo step.
    if (Object.keys(patch).length) patchItem(item.id, patch, false);
  }, [item.id, patchItem]);

  if (embedded) return <YoutubeItem item={item} interactive={live} />;
  return (
    <VideoContent
      item={item}
      streamSrc={nr.ytStreamUrl(item.ref)}
      onStreamError={() => { setEmbedded(true); onFallback(true); }}
      onNatSize={fitNatSize}
    />
  );
}

function ItemContent({ item, editing, live, onYtFallback }: { item: Item; editing: boolean; live: boolean; onYtFallback: (on: boolean) => void }) {
  if (item.loading) return <LoadingContent item={item} />;
  if (item.missing) return <MissingContent item={item} />;
  if (item.kind === "text") return <TextNote item={item} editing={editing} />;
  if (item.kind === "frame") return <FrameContent item={item} />;
  if (item.kind === "image") return <ImageContent item={item} />;
  if (item.kind === "video") return <VideoContent item={item} />;
  if (item.kind === "sequence") return <SequenceContent item={item} />;
  // Embed / YouTube : `live` (double-clic) rend l'iframe cliquable (play, scroll, liens). Sinon
  // pointer-events:none → le clic sélectionne / déplace l'item (le drag du board n'est pas volé).
  if (item.kind === "embed") return <EmbedItem item={item} interactive={live} />;
  return <YoutubeContent item={item} live={live} onFallback={onYtFallback} />;
}

export const BoardItem = memo(function BoardItem({
  item,
  selected,
  primary,
  editing,
}: {
  item: Item;
  selected: boolean;   // dans la multi-sélection
  primary: boolean;    // seul item sélectionné → poignées
  editing: boolean;
}) {
  const { t: tr } = useTranslation("reference");
  const wrapRef = useRef<HTMLDivElement>(null);
  const select = useBoard((s) => s.select);
  const toggleSelect = useBoard((s) => s.toggleSelect);
  const bringToFront = useBoard((s) => s.bringToFront);
  const updateItem = useBoard((s) => s.updateItem);
  const removeItem = useBoard((s) => s.removeItem);
  const moveBy = useBoard((s) => s.moveBy);
  const setEditing = useBoard((s) => s.setEditing);

  // Mode interactif des embeds/YouTube : double-clic → l'iframe devient cliquable (play/scroll/liens).
  // On en sort dès que l'item n'est plus seul sélectionné (clic ailleurs / Échap) → on peut le déplacer.
  const [live, setLive] = useState(false);
  // Un YouTube joué en flux direct est une vidéo comme une autre : rien à « activer » au double-clic.
  // Seul le repli iframe redevient interactif.
  const [ytFallback, setYtFallback] = useState(false);
  const liveable = item.kind === "embed" || (item.kind === "youtube" && ytFallback);
  useEffect(() => { if (!primary) setLive(false); }, [primary]);

  const t = usePointerTransform(
    { x: item.x, y: item.y, w: item.w, h: item.h, rotation: item.rotation },
    (g) => {
      // Déplacement pur (taille/rotation inchangées).
      const pureMove = g.w === item.w && g.h === item.h && g.rotation === item.rotation;
      const dx = g.x - item.x, dy = g.y - item.y;
      updateItem(item.id, g);
      if (pureMove && (dx !== 0 || dy !== 0)) {
        const st = useBoard.getState();
        const sel = st.selectedIds;
        if (sel.length > 1 && sel.includes(item.id)) {
          // multi-sélection → bouge tout le groupe.
          moveBy(sel.filter((id) => id !== item.id), dx, dy);
        } else if (item.kind === "frame") {
          // cadre = conteneur : déplace les items dont le centre est dans le cadre (position d'origine).
          const inFrame = (cx: number, cy: number) =>
            cx >= item.x && cx <= item.x + item.w && cy >= item.y && cy <= item.y + item.h;
          const inside = st.items
            .filter(
              (it) =>
                it.kind !== "frame" &&
                it.kind !== "draw" &&
                it.id !== item.id &&
                inFrame(it.x + it.w / 2, it.y + it.h / 2),
            )
            .map((it) => it.id);
          if (inside.length) moveBy(inside, dx, dy);
          // Calque de dessin (singleton) : décale les formes dont le centre est dans le cadre.
          const shapes = st.items.find((i) => i.kind === "draw")?.shapes;
          if (shapes?.length) {
            let moved = false;
            const next = shapes.map((s) => {
              const [a, b, c, d] = shapeBBox(s);
              if (inFrame((a + c) / 2, (b + d) / 2)) { moved = true; return shifted(s, dx, dy); }
              return s;
            });
            if (moved) st.drawSetShapes(next, false);
          }
        }
      }
    },
    // YouTube/lecteurs vidéo (Vimeo/Twitch…) = ratio VERROUILLÉ (16:9, sinon barres noires). Les
    // cartes sociales (twitter/tiktok/insta/reddit…) = ratio LIBRE : leur hauteur dépend du contenu
    // (texte variable) → l'utilisateur ajuste la hauteur, et Twitter/Instagram s'auto-redimensionnent.
    {
      keepAspect:
        item.kind === "image" || item.kind === "video" || item.kind === "youtube" || item.kind === "sequence"
        || (item.kind === "embed"
            && EMBED_PLAYER_PROVIDERS.has(parseVideoEmbed(item.ref, true)?.provider ?? "generic")),
      captureRef: wrapRef,
    },
  );
  const g = t.geom;
  const flip = `scale(${item.flipH ? -1 : 1}, ${item.flipV ? -1 : 1})`;
  // Médias animés → couche composite dédiée (cf. wrapper du contenu plus bas) pour ne pas figer au pan.
  // YouTube en flux direct est une vidéo comme une autre → même traitement.
  const promote = item.kind === "video" || item.kind === "sequence" || (item.kind === "youtube" && !ytFallback);

  return (
    <div
      ref={wrapRef}
      data-board-item={item.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (editing) return; // note en édition : laisser le textarea gérer
        if (e.shiftKey) { toggleSelect(item.id); return; }
        if (!selected) select(item.id);
        if (item.kind !== "frame") bringToFront(item.id); // le cadre reste en fond
        t.startMove(e);
      }}
      onDoubleClick={() => {
        if (item.kind === "text") setEditing(item.id);
        else if (liveable) setLive(true);
        else useBoard.getState().requestFocus(item.id); // image/vidéo/séquence/cadre → centre + zoome
      }}
      onPointerMove={t.onPointerMove}
      onPointerUp={t.onPointerUp}
      onPointerCancel={t.onPointerCancel}
      className={cn(
        "absolute left-0 top-0 origin-center touch-none",
        editing ? "cursor-text" : t.dragging ? "cursor-grabbing" : "cursor-grab",
      )}
      style={{
        transform: `translate(${g.x}px, ${g.y}px) rotate(${g.rotation}deg)`,
        width: g.w,
        height: g.h,
        opacity: item.opacity ?? 1,
        zIndex: item.z,
      }}
    >
      <div
        className={cn(
          "h-full w-full rounded-sm transition-shadow",
          // le titre du cadre déborde en haut (onglet) → pas de clipping pour les cadres
          item.kind === "frame" ? "overflow-visible" : "overflow-hidden",
          item.kind === "frame" ? "" : "shadow-lg ring-1",
          item.kind === "text" || item.kind === "frame" ? "" : "bg-black/40",
          selected ? "ring-2 ring-primary" : item.kind === "frame" ? "" : "ring-black/30",
        )}
        style={{ background: item.kind === "text" ? item.bg : undefined }}
      >
        {/* Vidéo/séquence = couche composite PROPRE (translateZ + will-change) : au pan, le wrapper
            d'items s'anime ; sans couche dédiée, Chromium re-rasterise le média avec le parent et la
            lecture FIGE (repart à l'arrêt). Sa propre couche est juste repositionnée par le GPU. */}
        <div
          className="h-full w-full"
          style={
            promote
              ? { transform: `${flip} translateZ(0)`, willChange: "transform", backfaceVisibility: "hidden" }
              : { transform: flip }
          }
        >
          <ItemContent item={item} editing={editing} live={live} onYtFallback={setYtFallback} />
        </div>
      </div>

      {/* Indice d'interaction (embed/YouTube) : double-clic pour activer, clic ailleurs pour déplacer */}
      {liveable && primary && !editing && (
        <span className="pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-popover/90 px-2 py-0.5 text-[10px] font-medium text-popover-foreground shadow ring-1 ring-foreground/10">
          {live ? tr("item.interactiveActive") : tr("item.interactiveHint")}
        </span>
      )}

      {primary && !editing && (
        <>
          {HANDLES.map((h) => (
            <span
              key={h}
              onPointerDown={(e) => t.startResize(h, e)}
              className={cn("absolute z-10 size-2.5 rounded-full border border-background bg-primary shadow transition-transform hover:scale-125", HANDLE_POS[h])}
            />
          ))}
          <span
            onPointerDown={t.startRotate}
            className="absolute left-1/2 z-10 size-3 -translate-x-1/2 cursor-grab rounded-full border border-background bg-foreground shadow transition-shadow hover:ring-2 hover:ring-primary/60"
            style={{ top: -28 }}
          />
          <span className="absolute left-1/2 top-0 -z-0 h-5 w-px -translate-x-1/2 -translate-y-full bg-primary/60" />
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => removeItem(item.id)}
            aria-label={tr("common:action.delete")}
            className="absolute -right-2 -top-9 z-10 flex size-6 items-center justify-center rounded-full bg-destructive/90 text-white shadow hover:bg-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
});
