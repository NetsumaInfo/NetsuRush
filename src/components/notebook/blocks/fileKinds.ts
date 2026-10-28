// Classement des fichiers par extension (image/video/audio/document/
// archive/texte/autre) → icône + libellé + teinte. Sert au bloc « Fichier » pour l'affichage.
import { netsuIconOf, type IconComponent } from "@/components/NetsuIconOf";
import i18n from "@/i18n";

export type FileKind = "pdf" | "doc" | "sheet" | "slide" | "archive" | "audio" | "video" | "image" | "text" | "code" | "other";

const EXT: Record<string, FileKind> = {
  pdf: "pdf",
  doc: "doc", docx: "doc", odt: "doc", rtf: "doc", pages: "doc",
  xls: "sheet", xlsx: "sheet", ods: "sheet", csv: "sheet", numbers: "sheet",
  ppt: "slide", pptx: "slide", odp: "slide", key: "slide",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
  mp3: "audio", wav: "audio", flac: "audio", aac: "audio", ogg: "audio", m4a: "audio",
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image",
  txt: "text", md: "text", log: "text",
  js: "code", ts: "code", tsx: "code", jsx: "code", json: "code", py: "code", rs: "code", html: "code", css: "code",
};

const META: Record<FileKind, { label: string; icon: IconComponent; color: string }> = {
  pdf: { label: "PDF", icon: netsuIconOf("file-text"), color: "#e0533d" },
  doc: { get label() { return i18n.t("notebook:fileKind.doc"); }, icon: netsuIconOf("file-text"), color: "#2b7de9" },
  sheet: { get label() { return i18n.t("notebook:fileKind.sheet"); }, icon: netsuIconOf("file-spreadsheet"), color: "#2ba24c" },
  slide: { get label() { return i18n.t("notebook:fileKind.slide"); }, icon: netsuIconOf("presentation"), color: "#e08a2b" },
  archive: { get label() { return i18n.t("notebook:fileKind.archive"); }, icon: netsuIconOf("file-archive"), color: "#a86bd6" },
  audio: { get label() { return i18n.t("notebook:numberLabels.audio"); }, icon: netsuIconOf("file-audio"), color: "#d64f8f" },
  video: { get label() { return i18n.t("notebook:fileKind.video"); }, icon: netsuIconOf("file-video"), color: "#6b74e0" },
  image: { get label() { return i18n.t("notebook:fileKind.image"); }, icon: netsuIconOf("file-image"), color: "#3dc0c0" },
  text: { get label() { return i18n.t("notebook:fileKind.text"); }, icon: netsuIconOf("file-text"), color: "#7d8899" },
  code: { label: "Code", icon: netsuIconOf("code"), color: "#5a9e6f" },
  other: { get label() { return i18n.t("notebook:fileKind.other"); }, icon: netsuIconOf("file"), color: "#7d8899" },
};

export function extOf(nameOrUrl: string): string {
  const clean = nameOrUrl.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(nameOrUrl: string): FileKind {
  return EXT[extOf(nameOrUrl)] || "other";
}

export function kindMeta(kind: FileKind) {
  return META[kind];
}
