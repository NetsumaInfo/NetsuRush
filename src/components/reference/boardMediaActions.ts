// Bascule d'un item entre média TÉLÉCHARGÉ (fichier natif) et carte EMBED ancrée. Le lien d'origine
// d'un média extrait est mémorisé dans `item.sourceUrl` ; un embed porte le lien dans `item.ref`.
// Opèrent directement sur le store (utilisables depuis l'Inspector ET le menu contextuel).

import { nr } from "@/lib/bridge";
import i18n from "@/i18n";
import { displaySrc, fitSize, parseVideoEmbed, probeNat, youtubeId } from "./referenceShared";
import { useBoard } from "./useReferenceBoard";
import {
  originalOnlineSource,
  recoverableOnlineItems,
  runSequentialRecovery,
} from "./boardMediaRecovery";

export { recoverableOnlineItems } from "./boardMediaRecovery";

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(`reference:${key}`, opts);

// Média extrait (vidéo/image, avec sourceUrl) → revient au LECTEUR d'origine. YouTube est un kind à
// part (`parseVideoEmbed` ne le reconnaît pas) → on restaure `kind:"youtube"`. Les autres providers →
// carte embed ancrée. Le fichier déjà téléchargé est MÉMORISÉ (`localMedia`) et conservé sur disque :
// la bascule est un changement d'affichage, pas une suppression — sauf si les Paramètres le demandent.
export function convertToEmbed(id: string) {
  const st = useBoard.getState();
  const it = st.items.find((i) => i.id === id);
  if (!it?.sourceUrl) return;
  const drop = st.prefs.dropDownloadOnEmbed;
  const localMedia = drop ? undefined : { kind: it.kind, ref: it.ref, src: it.src, natW: it.natW, natH: it.natH };
  const yt = youtubeId(it.sourceUrl);
  if (yt) {
    const old = it.ref;
    st.patchItem(id, { kind: "youtube", ref: yt, src: yt, sourceUrl: undefined, crop: undefined, localMedia });
    if (drop) void nr.reference?.dropAsset?.(old);
    return;
  }
  const e = parseVideoEmbed(it.sourceUrl, true);
  if (!e) return;
  st.patchItem(id, { kind: "embed", ref: e.pageUrl, src: e.embedUrl, localMedia });
}

// Retour au fichier déjà téléchargé (mémorisé par `convertToEmbed`) : aucune extraction rejouée.
// Renvoie false s'il n'y a rien de mémorisé → l'appelant télécharge pour de bon.
function restoreLocalMedia(id: string): boolean {
  const st = useBoard.getState();
  const it = st.items.find((i) => i.id === id);
  const local = it?.localMedia;
  if (!it || !local) return false;
  // Géométrie inchangée : la bascule ne redimensionne pas un item que l'utilisateur a posé/ajusté.
  st.patchItem(id, {
    kind: local.kind, ref: local.ref, src: local.src,
    natW: local.natW, natH: local.natH,
    sourceUrl: it.sourceUrl || (it.kind === "youtube" ? `https://www.youtube.com/watch?v=${it.ref}` : it.ref),
    localMedia: undefined,
  });
  return true;
}

// Récupération d'UN média cassé/noir : embed → ré-extraction ; image/vidéo à lien distant mort →
// ré-résolution (resolveMedia, repli extractMedia). Repointe l'item sur un asset local durable.
// Renvoie false si rien de récupérable (pas de lien, ou échec) — l'appelant ne boucle pas.
export async function recoverMedia(id: string): Promise<boolean> {
  const st = useBoard.getState();
  const it = st.items.find((i) => i.id === id);
  if (!it) return false;
  if (it.kind === "embed") return downloadMediaFromEmbed(id);
  if (it.kind !== "image" && it.kind !== "video" && it.kind !== "sequence") return false;
  const link = originalOnlineSource(it) || (/^https?:/i.test(it.ref) ? it.ref : "");
  if (!link) return false;
  // Média YouTube dont le fichier n'est plus là (board reçu d'ailleurs, dossier compagnon nettoyé) :
  // on rend la CARTE YouTube au lieu de retélécharger. C'est exactement l'état qu'aurait l'item si
  // le lien venait d'être reposé sur le board — lecture immédiate par le flux relayé, à sa place et
  // à sa taille — et « Télécharger » reste à un clic pour qui veut le fichier.
  const yt = youtubeId(link);
  if (yt && it.kind !== "sequence") {
    st.patchItem(id, {
      kind: "youtube", ref: yt, src: yt,
      sourceUrl: undefined, missing: undefined, crop: undefined, localMedia: undefined,
      natW: undefined, natH: undefined,
    });
    return true;
  }
  st.setNotice({ kind: "ok", sticky: true, text: tr("notice.recoveringMedia") });
  try {
    let path: string | null = null;
    let kind: "image" | "video" = it.kind === "image" ? "image" : "video";
    const target = { projectPath: st.filePath || undefined, title: it.title || it.id };
    const extracted = await nr.reference?.extractMedia?.(link, target);
    if (extracted?.ok && extracted.items?.length) {
      const first = kind === "video"
        ? extracted.items.find((entry) => entry.kind === "video") ?? extracted.items[0]
        : extracted.items[0];
      path = first.path;
      kind = first.kind;
    } else {
      const resolved = await nr.reference?.resolveMedia?.(link, target);
      if (resolved?.ok && resolved.path) { path = resolved.path; kind = resolved.kind ?? kind; }
    }
    if (!path) { st.setNotice({ kind: "error", text: tr("notice.mediaUnrecoverable") }); return false; }
    if (it.kind === "sequence" && kind === "video" && nr.reference?.extractFrames) {
      const sequence = await nr.reference.extractFrames({
        path,
        fps: it.fps,
        max: it.frames?.length || 300,
        projectPath: st.filePath || undefined,
        title: it.title || it.id,
      });
      if (sequence.ok && sequence.frames?.length) {
        st.patchItem(id, {
          kind: "sequence",
          ref: sequence.frames[0],
          frames: sequence.frames,
          frame: Math.min(it.frame || 0, sequence.frames.length - 1),
          fps: sequence.fps || it.fps,
          missing: undefined,
          sourceUrl: link,
        });
        st.setNotice(null);
        return true;
      }
    }
    const src = displaySrc(kind, path);
    const nat = await probeNat(kind, src);
    st.patchItem(id, {
      kind, ref: path, src, missing: undefined, sourceUrl: link,
      frames: undefined, frame: undefined, fps: undefined, speed: undefined, seqPlay: undefined,
      seqIn: undefined, seqOut: undefined, prevMedia: undefined,
      ...(nat.w && nat.h ? { natW: nat.w, natH: nat.h } : {}),
    });
    st.setNotice(null);
    return true;
  } catch {
    st.setNotice({ kind: "error", text: tr("notice.recoverFailed") });
    return false;
  }
}

// Items dont le média local est introuvable et qu'un dossier peut rendre d'un coup. Les séquences
// en sont exclues : leur placeholder résume des dizaines de frames (« 12/30 images manquantes »),
// il ne désigne aucun fichier — elles gardent la relocalisation par item, qui rechoisit les images.
export const relocatableItems = () =>
  useBoard.getState().items.filter((it) => !!it.missing && it.kind !== "sequence");

// Relocalisation EN LOT : un board reçu en « lien » ou « aperçu » arrive avec autant de
// placeholders que de rushs référencés. Les reprendre un par un ne dit rien de plus que « ils sont
// tous dans ce dossier » — alors on demande le dossier, une fois.
export async function relocateMissingMedia(): Promise<number> {
  const api = nr.reference;
  const targets = relocatableItems();
  const st = useBoard.getState();
  if (!api?.relocateFrom || !targets.length) return 0;
  const dir = await nr.chooseDir();
  if (!dir) return 0;

  st.setNotice({ kind: "ok", sticky: true, text: tr("notice.relocating", { count: targets.length }) });
  const res = await api.relocateFrom(
    dir,
    targets.map((it) => ({ id: it.id, name: it.missing?.name || "", size: it.missing?.size })),
  );
  if (!res?.ok) {
    st.setNotice({ kind: "error", text: tr("notice.failedWith", { error: res?.error || tr("notice.unknown") }) });
    return 0;
  }
  for (const hit of res.found) {
    const item = useBoard.getState().items.find((i) => i.id === hit.id);
    if (!item) continue;
    useBoard.getState().patchItem(item.id, {
      ref: hit.path,
      src: displaySrc(item.kind, hit.path),
      missing: undefined,
    });
  }
  useBoard.getState().setNotice(
    res.found.length
      ? { kind: "ok", text: tr("notice.relocated", { count: res.found.length, total: targets.length }) }
      : { kind: "error", text: tr("notice.relocatedNone") },
  );
  return res.found.length;
}

export async function recoverAllOnlineMedia() {
  const items = recoverableOnlineItems(useBoard.getState().items);
  const result = await runSequentialRecovery(
    items,
    (item) => recoverMedia(item.id),
    (current, total) => {
      useBoard.getState().setNotice({
        kind: "ok",
        sticky: true,
        text: tr("notice.recoveringOnline", { current, total }),
      });
    },
  );
  useBoard.getState().setNotice(
    result.recovered ? { kind: "ok", text: tr("notice.mediaRecovered", { count: result.recovered }) } : null,
  );
  return result;
}

// Balaye le board après import : ré-extrait en média local les embeds des plateformes CHOISIES dans
// les Paramètres (les lecteurs propres — vimeo/dailymotion/twitch/streamable — embarquent bien et
// n'y figurent pas). Séquentiel (yt-dlp lourd, pas de rafale). Best-effort : un embed non
// récupérable reste tel quel. Renvoie le nombre récupéré.
export async function recoverOnlineEmbeds(): Promise<number> {
  if (!nr.reference?.extractMedia) return 0;
  const wanted = new Set(useBoard.getState().prefs.autoDownloadProviders);
  const ids = useBoard
    .getState()
    .items.filter((it) => it.kind === "embed" && wanted.has(parseVideoEmbed(it.ref, true)?.provider ?? "generic"))
    .map((it) => it.id);
  if (!ids.length) return 0;
  let done = 0;
  for (const id of ids) {
    const cur = useBoard.getState().items.find((i) => i.id === id);
    if (!cur || cur.kind !== "embed") continue; // déjà récupéré entre-temps
    useBoard.getState().setNotice({ kind: "ok", sticky: true, text: tr("notice.recoveringOnline", { current: done + 1, total: ids.length }) });
    if (await downloadMediaFromEmbed(id)) done++;
  }
  useBoard.getState().setNotice(done ? { kind: "ok", text: tr("notice.mediaRecovered", { count: done }) } : null);
  return done;
}

// Séquence → revient au média d'ORIGINE mémorisé (`prevMedia`) : lecteur YouTube si la source était un
// lien YouTube, sinon la vidéo/image locale. Efface les champs de séquence (frames temp = jetables).
export function revertSequence(id: string) {
  const st = useBoard.getState();
  const it = st.items.find((i) => i.id === id);
  if (!it || it.kind !== "sequence" || !it.prevMedia) return;
  const pm = it.prevMedia;
  const clear = {
    frames: undefined, frame: undefined, fps: undefined, speed: undefined, seqPlay: undefined,
    seqIn: undefined, seqOut: undefined, prevMedia: undefined,
  };
  const yt = pm.sourceUrl ? youtubeId(pm.sourceUrl) : null;
  if (yt) {
    st.patchItem(id, { kind: "youtube", ref: yt, src: yt, sourceUrl: undefined, crop: undefined, ...clear });
    return;
  }
  st.patchItem(id, {
    kind: pm.kind ?? "video", ref: pm.ref, src: pm.src,
    trimIn: pm.trimIn, trimOut: pm.trimOut, crop: pm.crop, sourceUrl: pm.sourceUrl, ...clear,
  });
}

// Lien YouTube → télécharge la vidéo en fichier local (yt-dlp) et remplace l'item `youtube` par la
// vidéo native — dès lors lisible, rognable, extractible en frames, upscalable comme tout média local.
// L'URL d'origine est gardée dans `sourceUrl` (bouton « ouvrir le lien » + base d'un futur retour arrière).
export async function downloadYoutube(id: string): Promise<boolean> {
  if (restoreLocalMedia(id)) return true;
  const st = useBoard.getState();
  const it = st.items.find((i) => i.id === id);
  if (!it || it.kind !== "youtube" || !nr.reference?.extractMedia) return false;
  const url = `https://www.youtube.com/watch?v=${it.ref}`;
  st.setNotice({ kind: "ok", sticky: true, text: tr("notice.downloadingVideo") });
  try {
    const res = await nr.reference.extractMedia(url, {
      projectPath: st.filePath || undefined,
      title: it.title || "YouTube",
    });
    const first = res.ok ? res.items?.find((m) => m.kind === "video") ?? res.items?.[0] : undefined;
    if (first) {
      const src = displaySrc(first.kind, first.path);
      const nat = await probeNat(first.kind, src);
      const { w, h } = fitSize(nat.w, nat.h);
      st.patchItem(id, {
        kind: first.kind, ref: first.path, src, w, h,
        natW: nat.w || undefined, natH: nat.h || undefined, sourceUrl: url,
      });
      st.setNotice({ kind: "ok", text: tr("notice.videoDownloaded") });
      return true;
    }
    st.setNotice({ kind: "error", text: tr("notice.downloadImpossible") });
    return false;
  } catch {
    st.setNotice({ kind: "error", text: tr("notice.downloadFailed") });
    return false;
  }
}

// Carte embed → extrait le vrai média (yt-dlp/gallery-dl) et remplace l'item par le fichier natif.
// Les médias additionnels (carrousel) sont posés à côté. Renvoie true si un média a été posé.
export async function downloadMediaFromEmbed(id: string): Promise<boolean> {
  if (restoreLocalMedia(id)) return true;
  const st = useBoard.getState();
  const it = st.items.find((i) => i.id === id);
  if (!it || it.kind !== "embed" || !nr.reference?.extractMedia) return false;
  const url = it.sourceUrl || it.ref;
  st.setNotice({ kind: "ok", sticky: true, text: tr("notice.recoveringMedia") });
  try {
    const res = await nr.reference.extractMedia(url, {
      projectPath: st.filePath || undefined,
      title: it.title || "media",
    });
    if (res.ok && res.items?.length) {
      const [first, ...rest] = res.items;
      const src = displaySrc(first.kind, first.path);
      const nat = await probeNat(first.kind, src);
      const { w, h } = fitSize(nat.w, nat.h);
      st.patchItem(id, {
        kind: first.kind, ref: first.path, src, w, h,
        natW: nat.w || undefined, natH: nat.h || undefined, sourceUrl: url,
      });
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        const asrc = displaySrc(a.kind, a.path);
        const an = await probeNat(a.kind, asrc);
        const s = fitSize(an.w, an.h);
        st.addItem({
          kind: a.kind, ref: a.path, src: asrc,
          x: it.x + (i + 1) * 28, y: it.y + (i + 1) * 28, w: s.w, h: s.h, rotation: 0,
          natW: an.w || undefined, natH: an.h || undefined, title: it.title, sourceUrl: url,
        });
      }
      st.setNotice(null);
      return true;
    }
    st.setNotice({ kind: "error", text: tr("notice.mediaNotFound") });
    return false;
  } catch {
    st.setNotice({ kind: "error", text: tr("notice.extractFailed") });
    return false;
  }
}
