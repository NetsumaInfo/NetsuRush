// Constantes et helpers PURS de NetsuBridge. Aucun import du store.
import type { TransferHost, TransferPreview } from "@/lib/bridge";

/**
 * Couples SUPPORTÉS. Premiere Pro et After Effects se parlent déjà nativement (Dynamic Link) : un
 * transfert par NetsuRush entre ces deux-là n'apporterait rien. After Effects n'est donc qu'une
 * DESTINATION, et le seul retour vers Resolve part de Premiere.
 */
export const TRANSFER_TARGETS: Record<TransferHost, TransferHost[]> = {
  resolve: ["ppro", "aeft"],
  ppro: ["resolve"],
  aeft: [],
};

export const TRANSFER_SOURCES: TransferHost[] = (Object.keys(TRANSFER_TARGETS) as TransferHost[])
  .filter((host) => TRANSFER_TARGETS[host].length > 0);

export function isSupportedPair(from: TransferHost, to: TransferHost): boolean {
  return TRANSFER_TARGETS[from].includes(to);
}

export function defaultTarget(from: TransferHost): TransferHost {
  return TRANSFER_TARGETS[from][0];
}

/** Le couple inverse est-il lui aussi supporté ? (seul Resolve ⇄ Premiere l'est). */
export function canSwap(from: TransferHost, to: TransferHost): boolean {
  return isSupportedPair(to, from);
}

const FROM_KEY = "nr.transfer.from";
const TO_KEY = "nr.transfer.to";

function isTransferHost(value: unknown): value is TransferHost {
  return value === "resolve" || value === "ppro" || value === "aeft";
}

/** Couple mémorisé par FENÊTRE (comme l'hôte actif) : ce n'est pas un réglage de travail partagé. */
export function loadPair(): { from: TransferHost; to: TransferHost } {
  try {
    const from = localStorage.getItem(FROM_KEY);
    const to = localStorage.getItem(TO_KEY);
    if (isTransferHost(from) && isTransferHost(to) && isSupportedPair(from, to)) return { from, to };
  } catch {
    // Stockage du webview indisponible : on repart du couple par défaut.
  }
  return { from: "resolve", to: "ppro" };
}

export function savePair(from: TransferHost, to: TransferHost): void {
  try {
    localStorage.setItem(FROM_KEY, from);
    localStorage.setItem(TO_KEY, to);
  } catch {
    // Idem : la page reste utilisable sans mémorisation.
  }
}

/**
 * Resolve → After Effects est le seul couple doté d'un pipeline dédié (transforms, vitesse,
 * précompositions, transcodes par plan). Ailleurs, le transfert recopie les plans tels quels.
 */
export function hasRichAeOptions(from: TransferHost, to: TransferHost): boolean {
  return from === "resolve" && to === "aeft";
}

/** Durée de l'aperçu en h:mm:ss. */
export function previewDuration(preview: TransferPreview | null): string | null {
  if (!preview?.durationFrames || !preview.fps) return null;
  const total = Math.round(preview.durationFrames / preview.fps);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
