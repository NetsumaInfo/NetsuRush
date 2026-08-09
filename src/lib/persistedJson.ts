/** Petite couche de persistance pour les réglages de vues démontées entre deux onglets. */
export function readPersistedObject<T extends object>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    return { ...fallback, ...(value as Partial<T>) } as T;
  } catch {
    return fallback;
  }
}

export function writePersistedObject<T extends object>(key: string, value: T): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible/plein */ }
}

export function readPersistedValue<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePersistedValue<T>(key: string, value: T): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible/plein */ }
}
