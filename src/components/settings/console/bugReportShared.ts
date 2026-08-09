// Taxinomie du rapport de bug + mise en forme du rapport téléchargeable. Fonctions PURES.
// Les catégories décrivent la NATURE du défaut, pas la zone du produit (déjà couverte par « Module »).

import type { BugContext, BugReportRequest } from "@/lib/bridge";

export type BugGroup = "problem" | "improvement" | "other";

export type BugCategory = {
  id: string;
  group: BugGroup;
};

// Les ids voyagent jusqu'à Discord : ne jamais les renommer pour ajuster un libellé (les libellés
// vivent dans `bugReport.categories.<id>` des traductions).
export const BUG_CATEGORIES: BugCategory[] = [
  { id: "crash", group: "problem" },
  { id: "freeze", group: "problem" },
  { id: "startup", group: "problem" },
  { id: "dataLoss", group: "problem" },
  { id: "wrongResult", group: "problem" },
  { id: "playback", group: "problem" },
  { id: "export", group: "problem" },
  { id: "hostLink", group: "problem" },
  { id: "ai", group: "problem" },
  { id: "download", group: "problem" },
  { id: "performance", group: "problem" },
  { id: "ui", group: "problem" },
  { id: "accessibility", group: "problem" },
  { id: "i18n", group: "problem" },
  { id: "security", group: "problem" },
  { id: "regression", group: "problem" },
  { id: "feature", group: "improvement" },
  { id: "ux", group: "improvement" },
  { id: "question", group: "other" },
  { id: "other", group: "other" },
];

export const BUG_GROUPS: BugGroup[] = ["problem", "improvement", "other"];

// `idea` n'est pas proposé : il est posé dès que la catégorie n'est pas un problème.
export const BUG_SEVERITIES = ["blocker", "major", "minor"] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number] | "idea";

export const BUG_FREQUENCIES = ["always", "often", "rare", "once"] as const;
export type BugFrequency = (typeof BUG_FREQUENCIES)[number];

export const DEFAULT_CATEGORY = "crash";
export const DEFAULT_SEVERITY: BugSeverity = "major";
export const DEFAULT_FREQUENCY: BugFrequency = "always";

export function categoryGroup(id: string): BugGroup {
  return BUG_CATEGORIES.find((c) => c.id === id)?.group ?? "other";
}

/** Suffixe de clé i18n de la zone de texte : « raconte le problème », « ton idée » ou « ta demande ». */
export function descriptionKind(category: string): "" | "Idea" | "Other" {
  const group = categoryGroup(category);
  return group === "problem" ? "" : group === "improvement" ? "Idea" : "Other";
}

/** Ces deux entrées ne disent pas de quoi il s'agit : un champ court demande le sujet. */
export function needsOwnLabel(category: string): boolean {
  return category === "other" || category === "question";
}

/** Hors problème, pas de gravité à choisir. */
export function severityFor(category: string, chosen: BugSeverity): BugSeverity {
  return categoryGroup(category) === "problem" ? chosen : "idea";
}

// --- Masquage ----------------------------------------------------------------------------------

// Le nom de fichier reste (il explique souvent le bug) ; le chemin qui y mène part.
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\s"'<>|]*\\)?([^\s"'<>|\\]*)/g;
const UNIX_HOME = /\/(Users|home)\/[^/\s]+/g;
// Un jeton ou un webhook journalisé ne doit pas repartir dans un salon Discord.
const SECRETS = [
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi,
  /\b(?:Bearer|token|api[_-]?key|secret)\b["'\s:=]+[A-Za-z0-9._\-]{12,}/gi,
];
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g;

/** Masque chemins, adresses e-mail et secrets d'un texte destiné à l'envoi. */
export function redact(text: string): string {
  let out = text.replace(WINDOWS_PATH, (_m, file: string) => (file ? `…\\${file}` : "…\\"));
  out = out.replace(UNIX_HOME, "/$1/[user]");
  out = out.replace(EMAIL, "[email]");
  for (const rx of SECRETS) out = out.replace(rx, "[secret]");
  return out;
}

// --- Rapport téléchargeable --------------------------------------------------------------------

/** Bloc « machine » en clair, identique à la pièce jointe Discord. */
export function formatContext(ctx: BugContext | null): string {
  if (!ctx) return "Contexte machine indisponible (service hors ligne).";
  const disk = ctx.storage?.disk;
  const lines = [
    `App        : v${ctx.app.version || "?"} · langue ${ctx.app.lang || "auto"}`,
    `OS         : ${ctx.os.label} (${ctx.os.arch})`,
    `CPU        : ${ctx.cpu.name} · ${ctx.cpu.threads} threads`,
    `RAM        : ${ctx.memory.totalMB} Mo total · ${ctx.memory.freeMB} Mo libres`,
    `GPU        : ${ctx.gpu.label ?? "aucun"}`,
    ...ctx.gpu.devices.map((d) => `             ↳ ${d.name} · pilote ${d.driverVersion ?? "?"} · ${d.vendor}/${d.role}`),
    ctx.gpu.vram ? `VRAM       : ${ctx.gpu.vram.freeMB} Mo libres / ${ctx.gpu.vram.totalMB} Mo` : "",
    `Backends   : torch ${ctx.runtime.backends.ml} · onnx ${ctx.runtime.backends.onnx} · asr ${ctx.runtime.backends.transcribe}`,
    `Node       : ${ctx.runtime.node}`,
    `ffmpeg     : ${ctx.runtime.ffmpeg ?? "introuvable"}`,
    ctx.encoding ? `Encodeurs  : h264 ${ctx.encoding.h264 ?? "aucun"} · h265 ${ctx.encoding.h265 ?? "aucun"} · av1 ${ctx.encoding.av1 ?? "aucun"}` : "",
    `Stockage   : ${disk ? `${disk.freeGB} Go libres / ${disk.totalGB} Go` : "inconnu"}`,
    `Setup      : ${ctx.setup.completedAt ? new Date(ctx.setup.completedAt).toISOString().slice(0, 10) : "jamais"} · python ${ctx.setup.pythonFound ? "ok" : "absent"} · ffmpeg ${ctx.setup.ffmpegFound ? "ok" : "absent"}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Rapport complet en texte : quand l'envoi échoue, il reste un fichier à coller quelque part. */
export function buildReportText(request: BugReportRequest, ctx: BugContext | null): string {
  const contact = request.contact || {};
  return [
    "=== RAPPORT NETSURUSH ===",
    `Date       : ${new Date().toISOString()}`,
    `Catégorie  : ${request.categoryLabel ?? request.category} (${request.category})`,
    request.categoryDetail ? `Précision  : ${request.categoryDetail}` : "",
    `Sévérité   : ${request.severityLabel ?? request.severity}`,
    `Fréquence  : ${request.frequencyLabel ?? request.frequency}`,
    `Module     : ${request.moduleLabel ?? request.module ?? "—"}`,
    `Hôte       : ${request.activeHost ?? "—"} · ${request.hostConnected ? "connecté" : "hors ligne"}`,
    `Testeur    : ${contact.discordName ?? contact.text ?? "—"}${contact.discordId ? ` (${contact.discordId})` : ""}`,
    request.videoReference ? `Source     : ${request.videoReference}` : "",
    "",
    "--- Description ---",
    request.issueText,
    request.stepsText ? `\n--- Reproduction ---\n${request.stepsText}` : "",
    request.expectedText ? `\n--- Attendu ---\n${request.expectedText}` : "",
    "",
    "--- Machine ---",
    ctx ? formatContext(ctx) : request.manualSpecs || formatContext(null),
    "",
    `--- Journal (${request.consoleLogCount} entrées, ${request.errorCount ?? 0} erreurs) ---`,
    request.consoleLogs || "(vide)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Nom de fichier horodaté, sans caractère interdit sous Windows. */
export function reportFileName(): string {
  return `netsurush-rapport-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
}
