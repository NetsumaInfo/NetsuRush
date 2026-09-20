import { useSyncExternalStore } from "react";

export const COLLAB_SURFACES = ["board", "collection", "notebook", "notebook-page"] as const;
export type CollabSurface = typeof COLLAB_SURFACES[number];
export type CollabProfile = "live" | "balanced" | "economy";
export type CollabPreferences = { profile: CollabProfile; overrides: Partial<Record<CollabSurface, CollabProfile>> };
const KEY = "netsurush.collab.preferences.v1";
const listeners = new Set<() => void>();
const isProfile = (value: unknown): value is CollabProfile => value === "live" || value === "balanced" || value === "economy";

export function validateCollabPreferences(value: unknown): CollabPreferences {
  if (!value || typeof value !== "object") return { profile: "balanced", overrides: { notebook: "live", "notebook-page": "live" } };
  const input = value && typeof value === "object" ? value as Partial<CollabPreferences> : {};
  const overrides: CollabPreferences["overrides"] = {};
  for (const surface of COLLAB_SURFACES) {
    const profile = input.overrides?.[surface];
    if (isProfile(profile)) overrides[surface] = profile;
  }
  return { profile: isProfile(input.profile) ? input.profile : "balanced", overrides };
}

function read(): CollabPreferences {
  try { return validateCollabPreferences(JSON.parse(localStorage.getItem(KEY) ?? "null")); }
  catch { return validateCollabPreferences(null); }
}
let current = read();
export const getCollabPreferences = () => current;
export function subscribeCollabPreferences(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setCollabPreferences(value: CollabPreferences) {
  const next = validateCollabPreferences(value);
  // Persist before publication: a rejected disk write must not masquerade as a saved preference.
  localStorage.setItem(KEY, JSON.stringify(next));
  current = next;
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== KEY && event.key !== null) return;
  current = read();
  listeners.forEach((listener) => listener());
});
export function useCollabPreferences() {
  return useSyncExternalStore(subscribeCollabPreferences, getCollabPreferences, getCollabPreferences);
}
export function getCollabCadence(surface: string): { batchMs: number; mediaConcurrency: number; autoDownload: boolean } {
  const profile = current.overrides[surface as CollabSurface] ?? current.profile;
  return {
    batchMs: profile === "live" ? 60 : profile === "economy" ? 900 : 200,
    mediaConcurrency: profile === "economy" ? 1 : 2,
    autoDownload: profile !== "economy",
  };
}
