// Ingestion de médias dans le board : fichiers déposés/choisis, presse-papier (image ou URL),
// URL d'image distante, lien YouTube. Calcule le ratio natif puis pose l'item centré dans le
// viewport courant. Source durable (`ref`) = chemin disque si dispo (→ nrmedia://), sinon
// objectURL/dataURL (transitoire ; la persistance milestone 2 écrit l'asset sur disque).

import { useCallback } from "react";
import { nr } from "@/lib/bridge";
import i18n from "@/i18n";
import {
  type ItemKind,
  type BoardItem,
  displaySrc,
  kindFromPath,
  youtubeId,
  youtubeNatSize,
  giphyGifUrl,
  parseVideoEmbed,
  EMBED_PLAYER_PROVIDERS,
  isVideoUrl,
  isImageUrl,
  fitSize,
  probeImage,
  probeVideo,
  probeNat,
} from "./referenceShared";
import { useBoard } from "./useReferenceBoard";

// Longest side of a freshly posed YouTube card. Kept apart from the media posing size (Settings):
// a YouTube card is a player, not a reference image the user sizes to taste.
const YT_MAX = 480;

// Hôte d'un lien → titre court d'un média extrait (ex. "x.com", "tiktok.com").
function hostTitle(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return i18n.t("reference:item.mediaFallback"); }
}

// Dernier segment d'un chemin → titre par défaut (sépare \ ou /).
function baseTitle(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

// Positions d'une grille centrée sur `c` (taille de cellule w×h + gouttière). Carré au plus juste
// (cols = ⌈√n⌉). SOURCE UNIQUE de la pose multi-cuts. Mêmes formules qu'avant l'extraction.
function gridLayout(
  count: number,
  w: number,
  h: number,
  c: { x: number; y: number },
  gap = 24,
): { x: number; y: number }[] {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const x0 = c.x - (cols * (w + gap) - gap) / 2;
  const y0 = c.y - (rows * (h + gap) - gap) / 2;
  return Array.from({ length: count }, (_, i) => ({
    x: x0 + (i % cols) * (w + gap),
    y: y0 + Math.floor(i / cols) * (h + gap),
  }));
}

// Extension de fichier à partir d'un type MIME de blob (presse-papier/drop), avec quelques alias.
function extFromMime(mime: string, kind: ItemKind): string {
  const sub = (mime.split("/")[1] || "").toLowerCase();
  const map: Record<string, string> = {
    jpeg: "jpg", "svg+xml": "svg", quicktime: "mov", "x-matroska": "mkv",
    "x-msvideo": "avi", ogg: "ogv",
  };
  return map[sub] || sub || (kind === "image" ? "png" : "mp4");
}

export function useBoardIngest(centerPoint: () => { x: number; y: number }) {
  const addItem = useBoard((s) => s.addItem);
  const removeItem = useBoard((s) => s.removeItem);

  // Placeholder carré + loader posé pendant le download/extraction d'un lien. Renvoie son id (retiré
  // une fois le vrai média posé, ou en cas d'échec). Le titre = hôte du lien (repère pour l'utilisateur).
  const addLoading = useCallback(
    (at: { x: number; y: number }, title?: string): string => {
      const SIZE = Math.round(useBoard.getState().prefs.mediaMaxSize * (2 / 3));
      return addItem({
        kind: "image", ref: "", src: "",
        x: at.x - SIZE / 2, y: at.y - SIZE / 2, w: SIZE, h: SIZE, rotation: 0,
        loading: true, title: title ?? i18n.t("reference:item.downloading"),
      });
    },
    [addItem],
  );

  // Pose UN item centré (ou à `at`) avec son ratio natif déjà mesuré. `extra` = champs additionnels
  // (trim, sourceUrl…). SOURCE UNIQUE du calcul taille → position centrée → addItem.
  const place = useCallback(
    (
      kind: ItemKind,
      ref: string,
      src: string,
      nat: { w: number; h: number },
      title?: string,
      at?: { x: number; y: number },
      extra?: Partial<BoardItem>,
    ) => {
      // YouTube = ratio annoncé par le lien (16:9, ou 9:16 pour un Short), borné à YT_MAX — d'où le
      // 480×270 historique en paysage et 270×480 en portrait ; embed = taille conseillée du provider
      // (socials = portrait/haut), repli 480×270 ; média = ratio natif mesuré, borné par la taille de
      // pose (Paramètres).
      const { w, h } =
        kind === "youtube" ? fitSize(nat.w || 1920, nat.h || 1080, YT_MAX)
        : kind === "embed" ? { w: nat.w || 480, h: nat.h || 270 }
        : fitSize(nat.w, nat.h, useBoard.getState().prefs.mediaMaxSize);
      const c = at ?? centerPoint();
      addItem({
        kind,
        ref,
        src,
        x: c.x - w / 2,
        y: c.y - h / 2,
        w,
        h,
        rotation: 0,
        natW: nat.w || undefined,
        natH: nat.h || undefined,
        title,
        ...extra,
      });
    },
    [addItem, centerPoint],
  );

  // Item depuis un chemin disque (drop fichier, Media Pool, résultat recherche).
  const addPath = useCallback(
    async (filePath: string, title?: string, at?: { x: number; y: number }) => {
      const kind = kindFromPath(filePath);
      if (!kind) return;
      const src = displaySrc(kind, filePath);
      const nat = await probeNat(kind, src);
      place(kind, filePath, src, nat, title ?? baseTitle(filePath), at);
    },
    [place],
  );

  // Cut (plan détecté) : item vidéo qui boucle sur [inSec, outSec].
  const addCut = useCallback(
    async (filePath: string, inSec: number, outSec: number, title?: string, at?: { x: number; y: number }) => {
      const src = displaySrc("video", filePath);
      const nat = await probeVideo(src);
      place("video", filePath, src, nat, title ?? baseTitle(filePath), at, { trimIn: inSec, trimOut: outSec });
    },
    [place],
  );

  // Plusieurs cuts d'un même rush, posés en grille autour du centre (sinon ils s'empilent).
  const addCuts = useCallback(
    async (filePath: string, cuts: { in: number; out: number; title?: string }[], at?: { x: number; y: number }) => {
      if (!cuts.length) return;
      const src = displaySrc("video", filePath);
      const nat = await probeVideo(src);
      const { w, h } = fitSize(nat.w, nat.h, useBoard.getState().prefs.mediaMaxSize);
      const grid = gridLayout(cuts.length, w, h, at ?? centerPoint());
      cuts.forEach((cut, i) => {
        addItem({
          kind: "video",
          ref: filePath,
          src,
          x: grid[i].x,
          y: grid[i].y,
          w,
          h,
          rotation: 0,
          natW: nat.w || undefined,
          natH: nat.h || undefined,
          trimIn: cut.in,
          trimOut: cut.out,
          title: cut.title ?? baseTitle(filePath),
        });
      });
    },
    [addItem, centerPoint],
  );

  // Séquence d'images : plusieurs frames image → un seul item `sequence`. Ratio pris
  // sur la 1re frame ; <2 frames → repli sur une image simple.
  const addSequence = useCallback(
    async (paths: string[], at?: { x: number; y: number }) => {
      const frames = paths.filter((p) => kindFromPath(p) === "image");
      if (frames.length < 2) {
        if (frames[0]) await addPath(frames[0], undefined, at);
        return;
      }
      const nat = await probeImage(displaySrc("image", frames[0]));
      place("sequence", frames[0], "", nat, baseTitle(frames[0]), at, {
        frames,
        frame: 0,
        // Images déjà sur disque : aucune source vidéo à interroger → la sentinelle « cadence source »
        // laisse la cadence de lecture par défaut de l'item.
        fps: useBoard.getState().prefs.seqFps || undefined,
        speed: 1,
        seqPlay: false,
      });
    },
    [place, addPath],
  );

  // Item depuis un objet File (navigateur, presse-papier, ou drop sans chemin résoluble).
  const addFile = useCallback(
    async (file: File) => {
      const [path] = await nr.pathsForFiles([file]);
      if (path) return addPath(path, file.name);
      const kind: ItemKind | null = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
          ? "video"
          : null;
      if (!kind) return;
      // Image OU vidéo collée/déposée sans chemin → l'écrire en asset disque (durable, survit au reload).
      if (nr.reference?.saveAsset) {
        try {
          const ext = extFromMime(file.type, kind);
          const res = await nr.reference.saveAsset(await file.arrayBuffer(), ext);
          if (res.ok && res.path) {
            const src = displaySrc(kind, res.path);
            const nat = await probeNat(kind, src);
            return place(kind, res.path, src, nat, file.name);
          }
        } catch {
          /* repli objectURL ci-dessous */
        }
      }
      const url = URL.createObjectURL(file);
      const nat = await probeNat(kind, url);
      place(kind, url, url, nat, file.name);
    },
    [addPath, place],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) void addFile(f);
    },
    [addFile],
  );

  // Lien vidéo en ligne. YouTube → kind "youtube" (boucle Player API) ; Vimeo/Dailymotion/Twitch/
  // Streamable → kind "embed" (iframe). `allowGenericEmbed` : tout lien http restant → embed iframe.
  const addVideoUrl = useCallback(
    (input: string, opts?: { allowGenericEmbed?: boolean }): boolean => {
      const yt = youtubeId(input);
      if (yt) {
        place("youtube", yt, yt, youtubeNatSize(input), "YouTube");
        return true;
      }
      const e = parseVideoEmbed(input, opts?.allowGenericEmbed ?? false);
      if (e) {
        place("embed", e.pageUrl, e.embedUrl, e.size ?? { w: 480, h: 270 }, e.provider);
        return true;
      }
      return false;
    },
    [place],
  );

  // URL d'image distante.
  const addImageUrl = useCallback(
    async (url: string, at?: { x: number; y: number }, sourceUrl = url) => {
      const nat = await probeImage(url);
      place("image", url, url, nat, undefined, at, { sourceUrl });
    },
    [place],
  );

  // URL distante d'un fichier vidéo direct (.mp4/.webm…) → item vidéo natif (hotlink direct).
  const addVideoFileUrl = useCallback(
    async (url: string, at?: { x: number; y: number }, sourceUrl = url) => {
      const nat = await probeVideo(url);
      place("video", url, url, nat, undefined, at, { sourceUrl });
    },
    [place],
  );

  // Média distant (CDN signé Discord, hotlink protégé, lien expirant…) : on télécharge les octets
  // CÔTÉ CORE (pas de CORS/référrer dans la WebView) et on persiste en asset disque (durable).
  // Repli : hotlink direct si le core est indispo ou refuse le download.
  const addRemoteMedia = useCallback(
    async (
      url: string,
      hint?: "image" | "video",
      at?: { x: number; y: number },
      sourceUrl = url,
    ): Promise<boolean> => {
      if ((hint === "video" || isVideoUrl(url)) && !useBoard.getState().prefs.autoDownloadOnline) {
        await addVideoFileUrl(url, at, sourceUrl);
        return true;
      }
      if (nr.reference?.fetchAsset) {
        try {
          const res = await nr.reference.fetchAsset(url, {
            projectPath: useBoard.getState().filePath || undefined,
            title: hostTitle(sourceUrl),
          });
          if (res.ok && res.path && res.kind) {
            const src = displaySrc(res.kind, res.path);
            const nat = await probeNat(res.kind, src);
            place(res.kind, res.path, src, nat, undefined, at, { sourceUrl });
            return true;
          }
        } catch {
          /* repli hotlink direct ci-dessous */
        }
      }
      if (hint === "video" || isVideoUrl(url)) { await addVideoFileUrl(url, at, sourceUrl); return true; }
      if (hint === "image" || isImageUrl(url)) { await addImageUrl(url, at, sourceUrl); return true; }
      return false;
    },
    [place, addVideoFileUrl, addImageUrl],
  );

  // Pose le(s) média(s) EXTRAIT(s) (yt-dlp/gallery-dl) — grille si plusieurs — en mémorisant le lien
  // d'origine (`sourceUrl`) → permet de rebasculer en carte embed plus tard.
  const placeExtracted = useCallback(
    async (items: { path: string; kind: "image" | "video" }[], sourceUrl: string, at?: { x: number; y: number }) => {
      const c = at ?? centerPoint();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const src = displaySrc(it.kind, it.path);
        const nat = await probeNat(it.kind, src);
        const off = i * 28; // décalage en escalier (plusieurs médias d'un même post ne se superposent pas)
        place(it.kind, it.path, src, nat, hostTitle(sourceUrl), { x: c.x + off, y: c.y + off }, { sourceUrl });
      }
    },
    [place, centerPoint],
  );

  // Résout le vrai média de N'IMPORTE quel lien (GIF host, imgur, article, CDN…) via OpenGraph
  // côté core, puis pose l'item. Rapide (≤2 requêtes), couvre tout ce qui expose une meta og:image
  // /og:video. Mémorise le lien d'origine (→ bascule embed possible). Renvoie true si posé.
  const resolvePageAndPlace = useCallback(
    async (url: string, at?: { x: number; y: number }): Promise<boolean> => {
      if (!nr.reference?.resolveMedia) return false;
      try {
        const res = await nr.reference.resolveMedia(url, {
          download: useBoard.getState().prefs.autoDownloadOnline,
          projectPath: useBoard.getState().filePath || undefined,
          title: hostTitle(url),
        });
        const locator = res.path ?? res.url;
        if (res.ok && locator && res.kind) {
          await placeExtracted([{ path: locator, kind: res.kind }], url, at);
          return true;
        }
      } catch {
        /* repli géré par addUrl */
      }
      return false;
    },
    [placeExtracted],
  );

  // Tente d'EXTRAIRE le vrai média derrière un lien (réseau social & co) via le core. Renvoie true si
  // au moins un média posé. La progression visuelle = le placeholder loader posé par addUrl.
  const extractAndPlace = useCallback(
    async (url: string, at?: { x: number; y: number }): Promise<boolean> => {
      if (!nr.reference?.extractMedia) return false;
      try {
        const res = await nr.reference.extractMedia(url, {
          projectPath: useBoard.getState().filePath || undefined,
          title: hostTitle(url),
        });
        if (res.ok && res.items?.length) {
          await placeExtracted(res.items, url, at);
          return true;
        }
      } catch {
        /* repli géré par addUrl */
      }
      return false;
    },
    [placeExtracted],
  );

  // Routage unifié d'un lien — pensé pour avaler TOUT lien média du web. Priorité : lecteur propre
  // (YouTube/Vimeo/Twitch → embed jouable) > fichier média direct (.mp4/.gif/.png ou ?format=…) >
  // réseau social reconnu (extraction yt-dlp/gallery-dl, repli OpenGraph) > lien générique
  // (OpenGraph d'abord — couvre GIF giphy/tenor, imgur, articles —, repli extraction ~1800 sites) >
  // carte embed ancrée > download CDN best-effort.
  const addUrl = useCallback(
    async (input: string, opts?: { allowGenericEmbed?: boolean }): Promise<boolean> => {
      const m = input.match(/https?:\/\/[^\s<>"']+/);
      const text = m ? m[0] : input.trim();
      if (!/^https?:\/\//i.test(text)) return false;
      const prefs = useBoard.getState().prefs;

      // 1. YouTube : lecteur relayé sans habillage par défaut ; extraction locale en mode auto.
      const yt = youtubeId(text);
      if (yt) {
        place("youtube", yt, yt, youtubeNatSize(text), "YouTube");
        return true;
      }

      // 2. Providers nommés : lecteur tant que leur téléchargement auto n'est pas explicitement actif.
      const e = parseVideoEmbed(text, false);
      const shouldDownloadProvider = !!e
        && prefs.autoDownloadOnline
        && prefs.autoDownloadProviders.includes(e.provider);
      if (e && (EMBED_PLAYER_PROVIDERS.has(e.provider) || !shouldDownloadProvider)) {
        place("embed", e.pageUrl, e.embedUrl, e.size ?? { w: 480, h: 270 }, e.provider);
        return true;
      }

      // À partir d'ici : téléchargement → on pose un PLACEHOLDER (carré + loader) à l'emplacement
      // cible, remplacé par le vrai média à l'arrivée (retiré en `finally` quoi qu'il arrive).
      const at = centerPoint();
      const loadingId = addLoading(at, hostTitle(text));
      try {
        // 3a. Giphy → URL CDN directe du GIF (la page bloque le scraping) → download image animée.
        const gif = giphyGifUrl(text);
        if (gif) return await addRemoteMedia(gif, "image", at, text);

        // 3b. Fichier média direct (.mp4/.gif/.png…, ou ?format=jpg) → download des octets.
        if (isVideoUrl(text)) return await addRemoteMedia(text, "video", at);
        if (isImageUrl(text)) return await addRemoteMedia(text, "image", at);

        // 4. Réseau social reconnu → extraction (qualité pleine, multi-images), repli OpenGraph.
        //    Instagram's OpenGraph result is only a poster, so failed video extraction falls back to
        //    the official embed below. Generic links still try OpenGraph first, then extraction.
        const ok = e
          ? (await extractAndPlace(text, at))
            || (e.provider !== "instagram" && await resolvePageAndPlace(text, at))
          : prefs.autoDownloadOnline
            ? (await resolvePageAndPlace(text, at)) || (await extractAndPlace(text, at))
            : await resolvePageAndPlace(text, at);
        if (ok) return true;

        // 5. Échec → repli carte embed ancrée (social, ou générique si autorisé).
        const fb = e ?? (opts?.allowGenericEmbed ? parseVideoEmbed(text, true) : null);
        if (fb) {
          place("embed", fb.pageUrl, fb.embedUrl, fb.size ?? { w: 480, h: 270 }, fb.provider, at);
          return true;
        }

        // 6. Dernier recours : download CDN (image hotlink sans extension propre).
        return await addRemoteMedia(text, undefined, at);
      } finally {
        removeItem(loadingId);
      }
    },
    [place, addRemoteMedia, extractAndPlace, resolvePageAndPlace, addLoading, removeItem, centerPoint],
  );

  // Presse-papier / drop sans fichiers : blobs image OU vidéo (multi) ou URL texte (routée).
  // Renvoie false si rien d'exploitable (presse-papier vide, lien irrésoluble) → feedback appelant.
  const addPaste = useCallback(
    async (data: DataTransfer): Promise<boolean> => {
      const blobs = Array.from(data.items)
        .filter((it) => it.kind === "file" && (it.type.startsWith("image/") || it.type.startsWith("video/")))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (blobs.length) {
        blobs.forEach((b) => void addFile(b));
        return true;
      }
      const text = (data.getData("text/plain") || data.getData("text/uri-list")).trim();
      if (text) return addUrl(text);
      return false;
    },
    [addFile, addUrl],
  );

  return { addPath, addCut, addCuts, addSequence, addFiles, addVideoUrl, addUrl, addImageUrl, addPaste };
}
