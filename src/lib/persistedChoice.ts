import { useCallback, useState } from "react";

// Réglage d'interface à valeurs finies (tri, mode d'affichage, onglet…) persisté en localStorage.
// Chaque onglet de l'app est DÉMONTÉ quand on le quitte, donc un `useState` nu repart à zéro à
// chaque aller-retour — c'est ce que ce hook évite.
// La valeur relue est validée contre la liste permise : une clé périmée (renommage d'une option)
// retombe sur le défaut au lieu de coincer l'interface dans un état qui n'existe plus.
export function usePersistedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof localStorage === "undefined") return fallback;
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  });
  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, v); } catch { /* best-effort */ }
  }, [key]);
  return [value, set] as const;
}
