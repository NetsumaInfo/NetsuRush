import type { CollectionShot, SearchHit } from "@/lib/bridge";
import i18n from "@/i18n";
import { useApp } from "@/store";
import { errorText } from "@/lib/errorText";
import { basename } from "@/lib/utils";

// Seuls les rush vidéo/image sont indexables (SigLIP 2 embed des images) — on exclut
// l'audio (.flac/.wav/.mp3…) et le reste, sinon la détection de plans plante.
const VIDEO_RE = /\.(mp4|mov|mkv|m4v|avi|mxf|webm|mts|m2ts|wmv|flv|mpg|mpeg|ts|3gp|r3d|braw)$/i;
export const IMAGE_RE = /\.(jpg|jpeg|png|tif|tiff|bmp|webp|dpx|exr)$/i;
export const isMedia = (p: string) => VIDEO_RE.test(p) || IMAGE_RE.test(p);
export const hitKey = (h: SearchHit) => `${h.file_path}#${h.scene_index}`;
// A hit as a collection shot (card button, right-click and grid selection must build it the same way).
export const hitShot = (h: SearchHit): CollectionShot => ({
  path: h.file_path, name: basename(h.file_path), in: h.start_sec, out: h.end_sec,
  inFrame: h.start_frame, outFrame: h.end_frame, srcFrames: h.src_frames, fps: h.fps,
});

// Classe de grille partagée entre la vue plate, les doublons et les groupes.
export const grid = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6";

// Erreur lisible si le core/sidecar est injoignable, au lieu d'un échec silencieux.
export const ipcErr = (e: unknown) =>
  useApp.setState({ searchError: i18n.t("search:store.genericUnavailable", { error: errorText(e) }) });
