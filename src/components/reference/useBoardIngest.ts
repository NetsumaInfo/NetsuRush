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
  makeFrameItem,
  topZ,
} from "./referenceShared";
import { useBoard } from "./useReferenceBoard";
import { boundsOf, computeArrange } from "./boardArrange";

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

// Exécute `run` sur toute la liste avec au plus `limit` tâches en vol. Vraie file d'attente, pas des
// paquets successifs : un décodage lent ne bloque plus les suivants (un `Promise.all` par tranche
// laissait 5 ouvriers inactifs le temps que la 6e vidéo réponde).
async function pool<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await run(items[i], i);
    }),
  );
}

// Au-delà, un média sans chemin disque n'est PAS recopié dans les assets : dupliquer des dizaines de
// gigaoctets pour un dossier de rushes lâché est pire que la perte de la source au rechargement.
const ASSET_COPY_MAX = 512 * 1024 * 1024;

// Une entrée de lot : soit un chemin disque (voie normale, zéro copie), soit un objet File quand la
// coquille n'a pas su rendre le chemin (navigateur, dossier déposé sur un runtime sans le pont).
type BatchEntry = { path?: string; file?: File; rel: string; name: string; kind: "image" | "video" };

// Nature d'un fichier de lot : extension d'abord, type MIME en secours (un fichier venu du
// navigateur ou d'une archive arrive parfois sans extension exploitable).
function entryKind(nameOrPath: string, mime = ""): "image" | "video" | null {
  const k = kindFromPath(nameOrPath);
  if (k === "image" || k === "video") return k;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
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
    async (file: File, at?: { x: number; y: number }) => {
      const [path] = await nr.pathsForFiles([file]);
      if (path) return addPath(path, file.name, at);
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
            return place(kind, res.path, src, nat, file.name, at);
          }
        } catch {
          /* repli objectURL ci-dessous */
        }
      }
      const url = URL.createObjectURL(file);
      const nat = await probeNat(kind, url);
      place(kind, url, url, nat, file.name, at);
    },
    [addPath, place],
  );

  // Un LOT posé en BLOC : jamais une pile au même point. Les médias sont rangés (et regroupés dans
  // un cadre par sous-dossier quand l'import vient d'un dossier), en UNE entrée d'annulation.
  //
  // Trois temps, pour ne jamais figer l'app sur un dossier de rushes :
  //   1. tous les items apparaissent D'UN COUP à une taille provisoire — l'import est perçu instantané ;
  //   2. les ratios réels (et, pour un fichier sans chemin, la copie en asset durable) sont mesurés
  //      en arrière-plan par une file d'attente, avec une progression VISIBLE ;
  //   3. le lot est rangé une seule fois, à ses vraies proportions, chaque groupe empilé sous le
  //      précédent d'après ses limites MESURÉES — sinon deux dossiers se recouvrent.
  const addBatch = useCallback(
    async (
      list: BatchEntry[],
      opts: { rootName?: string; frames?: boolean; at?: { x: number; y: number } } = {},
    ) => {
      if (!list.length) return;
      const store = useBoard.getState();
      const prefs = store.prefs;
      const box = prefs.mediaMaxSize;
      const gap = prefs.arrangeGap;
      const cell = box + gap;
      const origin = opts.at ?? centerPoint();
      const FRAME_PAD = 24;
      const FRAME_TOP = 44; // hauteur de l'étiquette du cadre

      // Un groupe par sous-dossier (ordre du scan, déjà trié).
      const groups = new Map<string, BatchEntry[]>();
      for (const f of list) {
        const key = f.rel || "";
        const bucket = groups.get(key);
        if (bucket) bucket.push(f);
        else groups.set(key, [f]);
      }

      // Plan d'empilement explicite : le CADRE passe sous son contenu. Sans ça, tout arriverait au
      // même z et le cadre, ajouté après ses médias, les recouvrirait — il capterait leurs clics.
      let z = topZ(store.items);
      const batch: BoardItem[] = [];
      const created: { id: string; kind: ItemKind; src: string; file?: File }[] = [];
      const groupPlan: { id: string | null; childIds: string[] }[] = [];
      const stamp = Date.now().toString(36);
      let cursorY = origin.y;

      let gi = 0;
      for (const [rel, files] of groups) {
        const cols = Math.ceil(Math.sqrt(files.length));
        const rows = Math.ceil(files.length / cols);
        const childIds: string[] = [];
        const groupKey = `${stamp}-${gi++}`;
        const startY = opts.frames ? cursorY + FRAME_TOP : cursorY;

        let frameId: string | null = null;
        if (opts.frames) {
          const frame = makeFrameItem(origin.x - FRAME_PAD, cursorY, { color: prefs.defaultFrameColor, fillMode: prefs.defaultFrameFill });
          frameId = `${groupKey}-f`;
          frame.id = frameId;
          frame.text = rel ? `${opts.rootName ?? ""}/${rel}` : opts.rootName ?? rel;
          frame.w = cols * cell - gap + FRAME_PAD * 2;
          frame.h = rows * cell - gap + FRAME_TOP + FRAME_PAD;
          frame.z = ++z;
          batch.push(frame);
        }

        files.forEach((f, i) => {
          const kind: ItemKind = f.kind === "video" ? "video" : "image";
          // Sans chemin disque, on affiche depuis un objectURL : c'est INSTANTANÉ (zéro octet copié
          // avant que l'image soit à l'écran). L'asset durable est écrit ensuite, en arrière-plan.
          const src = f.path ? displaySrc(kind, f.path) : URL.createObjectURL(f.file!);
          // Taille provisoire : carré pour une image, 16:9 pour une vidéo. Le vrai ratio arrive juste après.
          const id = `${groupKey}-${i}`;
          childIds.push(id);
          created.push({ id, kind, src, file: f.path ? undefined : f.file });
          batch.push({
            id,
            kind,
            ref: f.path ?? src,
            src,
            x: origin.x + (i % cols) * cell,
            y: startY + Math.floor(i / cols) * cell,
            w: box,
            h: kind === "video" ? Math.round((box * 9) / 16) : box,
            rotation: 0,
            z: ++z,
            title: f.name,
          });
        });

        groupPlan.push({ id: frameId, childIds });
        cursorY = startY + rows * cell + (opts.frames ? FRAME_PAD + 32 : 32);
      }

      useBoard.getState().addItems(batch, false);

      // Mesure des ratios (et copie en asset des fichiers sans chemin), file d'attente bornée : un
      // lot de 300 vidéos ne doit pas ouvrir 300 décodeurs d'un coup.
      let done = 0;
      const total = created.length;
      const tick = () => useBoard.getState().setNotice({ kind: "ok", sticky: true, text: i18n.t("reference:ingest.progress", { done, total }) });
      tick();
      await pool(created, 8, async (c) => {
        const nat = await probeNat(c.kind, c.src);
        if (nat.w && nat.h) {
          const size = fitSize(nat.w, nat.h, box);
          useBoard.getState().patchItem(c.id, { natW: nat.w, natH: nat.h, w: size.w, h: size.h }, false);
        }
        if (c.file && nr.reference?.saveAsset && c.file.size <= ASSET_COPY_MAX) {
          try {
            const res = await nr.reference.saveAsset(await c.file.arrayBuffer(), extFromMime(c.file.type, c.kind));
            if (res.ok && res.path) {
              const durable = displaySrc(c.kind, res.path);
              useBoard.getState().patchItem(c.id, { ref: res.path, src: durable }, false);
              URL.revokeObjectURL(c.src);
            }
          } catch {
            // Écriture refusée : l'objectURL tient la session, la source d'origine reste sur disque.
          }
        }
        done++;
        tick();
      });

      // Rangement final, en UN seul rendu : chaque groupe est disposé à ses vraies proportions, puis
      // recollé sous le précédent d'après ses limites mesurées, et son cadre ajusté au résultat.
      const state = useBoard.getState();
      const byId = new Map(state.items.map((it) => [it.id, it]));
      const next = new Map<string, BoardItem>();
      let stackY = origin.y;
      for (const g of groupPlan) {
        const kids = g.childIds.map((id) => byId.get(id)).filter((it): it is BoardItem => !!it);
        if (!kids.length) continue;
        let placed = kids;
        if (prefs.autoArrangeOnImport && kids.length > 1) {
          const pos = computeArrange(kids, prefs.arrangeLayout, { gap: prefs.arrangeGap, sort: prefs.arrangeSort });
          if (pos.size) placed = kids.map((it) => (pos.has(it.id) ? { ...it, ...pos.get(it.id)! } : it));
        }
        const b = boundsOf(placed);
        const top = stackY + (g.id ? FRAME_TOP : 0);
        const dx = origin.x - b.x;
        const dy = top - b.y;
        placed = placed.map((it) => ({ ...it, x: it.x + dx, y: it.y + dy }));
        placed.forEach((it) => next.set(it.id, it));
        if (g.id) {
          const fb = boundsOf(placed);
          const frame = byId.get(g.id);
          if (frame) {
            next.set(g.id, {
              ...frame,
              x: fb.x - FRAME_PAD, y: fb.y - FRAME_TOP,
              w: fb.w + FRAME_PAD * 2, h: fb.h + FRAME_TOP + FRAME_PAD,
            });
          }
        }
        stackY = top + b.h + (g.id ? FRAME_PAD : 0) + 32;
      }
      if (next.size) {
        // Le lot entier est CENTRÉ sur le point d'arrivée (curseur du dépôt, sinon centre du
        // viewport) : ancré par son coin, un import un peu large partait hors de l'écran.
        const all = [...next.values()];
        const tb = boundsOf(all);
        const dx = origin.x - (tb.x + tb.w / 2);
        const dy = origin.y - (tb.y + tb.h / 2);
        for (const it of all) next.set(it.id, { ...it, x: it.x + dx, y: it.y + dy });
        useBoard.setState({ items: state.items.map((it) => next.get(it.id) ?? it) });
      }

      useBoard.getState().setNotice({ kind: "ok", text: i18n.t("reference:ingest.done", { count: total }) });
    },
    [centerPoint],
  );

  // Fichiers déposés ou choisis : posés EN BLOC, jamais un par un et jamais empilés au même point.
  // Les chemins disque se résolvent en UN aller-retour ; ceux qui manquent (navigateur, runtime sans
  // le pont) rejoignent LE MÊME lot par leur objet File — même pose immédiate, même rangement, même
  // progression. L'ancienne voie de repli les traitait en série et les posait tous au centre du
  // viewport : import interminable et planche illisible.
  const addFiles = useCallback(
    (files: FileList | File[], at?: { x: number; y: number }) => {
      const all = Array.from(files);
      if (!all.length) return;
      if (all.length === 1) { void addFile(all[0], at); return; }
      void (async () => {
        useBoard.getState().setNotice({ kind: "ok", sticky: true, text: i18n.t("reference:ingest.reading", { count: all.length }) });
        const paths = await nr.pathsForFiles(all);
        const list: BatchEntry[] = [];
        const others: File[] = [];
        all.forEach((f, i) => {
          const p = paths[i];
          const kind = entryKind(p || f.name, f.type);
          if (!kind) { others.push(f); return; }
          list.push(p ? { path: p, rel: "", name: f.name, kind } : { file: f, rel: "", name: f.name, kind });
        });
        if (list.length) await addBatch(list, { at });
        else useBoard.getState().setNotice(null);
        for (const f of others) await addFile(f, at);
      })();
    },
    [addFile, addBatch],
  );

  // Dossier CHOISI (menu) : le core parcourt l'arborescence, puis le lot est posé en cadres.
  // Renvoie false si le core n'a rien pu rendre — le dépôt d'un dossier s'en sert pour basculer sur
  // son parcours navigateur au lieu d'abandonner (le core d'une session pas encore redémarrée ne
  // connaît pas encore ce canal).
  const addFolder = useCallback(
    async (dirPath: string, at?: { x: number; y: number }): Promise<boolean> => {
      if (!nr.reference?.scanFolder) {
        useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:ingest.folderUnavailable") });
        return false;
      }
      useBoard.getState().setNotice({ kind: "ok", sticky: true, text: i18n.t("reference:ingest.folderScanning") });
      const scan = await nr.reference.scanFolder(dirPath, {}).catch(() => null);
      if (!scan) return false;
      if (!scan.ok || !scan.count) {
        useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:ingest.folderEmpty") });
        return false;
      }
      await addBatch(scan.files, { rootName: scan.name, frames: true, at });
      if (scan.truncated) {
        useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:ingest.folderTruncated", { count: scan.count }) });
      }
      return true;
    },
    [addBatch],
  );

  // Dossier DÉPOSÉ. Trois voies, dans cet ordre, pour qu'un dossier lâché finisse TOUJOURS sur la
  // planche :
  //   1. le chemin disque du dossier lui-même (la coquille le rend pour l'objet `File` que le drop
  //      place à côté de l'entrée) → le core parcourt l'arborescence, zéro octet copié ;
  //   2. sinon, parcours côté navigateur (API Entries du drop) puis chemin de chaque FICHIER trouvé ;
  //   3. et ce qui ne se résout pas part quand même, par son objet File.
  const addDroppedEntry = useCallback(
    async (entry: FileSystemDirectoryEntry, dirFile?: File | null, at?: { x: number; y: number }) => {
      useBoard.getState().setNotice({ kind: "ok", sticky: true, text: i18n.t("reference:ingest.folderScanning") });
      if (dirFile && nr.reference?.scanFolder) {
        const [dirPath] = await nr.pathsForFiles([dirFile]).catch(() => [""]);
        if (dirPath && await addFolder(dirPath, at)) return;
      }
      const found: { file: File; rel: string }[] = [];

      const readAll = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
        new Promise((resolve) => {
          const out: FileSystemEntry[] = [];
          const step = () => reader.readEntries((batch) => {
            // `readEntries` rend les enfants par paquets : il faut rappeler jusqu'au paquet vide.
            if (!batch.length) { resolve(out); return; }
            out.push(...batch);
            step();
          }, () => resolve(out));
          step();
        });

      const walk = async (dir: FileSystemDirectoryEntry, rel: string, depth: number) => {
        if (found.length >= 1000 || depth > 6) return;
        for (const child of await readAll(dir.createReader())) {
          if (found.length >= 1000) return;
          if (child.isDirectory) {
            await walk(child as FileSystemDirectoryEntry, rel ? `${rel}/${child.name}` : child.name, depth + 1);
          } else {
            const file = await new Promise<File | null>((resolve) =>
              (child as FileSystemFileEntry).file((f) => resolve(f), () => resolve(null)));
            if (file) found.push({ file, rel });
          }
        }
      };

      await walk(entry, "", 0);
      if (!found.length) {
        useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:ingest.folderEmpty") });
        return;
      }

      const paths = await nr.pathsForFiles(found.map((f) => f.file));
      const list: BatchEntry[] = [];
      found.forEach((f, i) => {
        const p = paths[i];
        const kind = entryKind(p || f.file.name, f.file.type);
        if (!kind) return;
        list.push(p
          ? { path: p, rel: f.rel, name: f.file.name, kind }
          : { file: f.file, rel: f.rel, name: f.file.name, kind });
      });
      if (!list.length) {
        useBoard.getState().setNotice({ kind: "error", text: i18n.t("reference:ingest.folderEmpty") });
        return;
      }
      await addBatch(list, { rootName: entry.name, frames: true, at });
    },
    [addBatch, addFolder],
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

  return { addPath, addCut, addCuts, addSequence, addFiles, addFolder, addDroppedEntry, addVideoUrl, addUrl, addImageUrl, addPaste };
}
