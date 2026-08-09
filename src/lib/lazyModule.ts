// Singleton de module chargé PARESSEUSEMENT. Une dépendance lourde qu'une seule vue référence
// (catalogue d'icônes, moteur LaTeX, lecteur PDF) n'a pas à peser sur le chunk de cette vue : elle
// part dans un chunk asynchrone, fetché au premier usage réel.
//
// Contrat : `get()` renvoie `null` tant que rien n'est arrivé (le composant rend son repli),
// `use()` déclenche le chargement et re-rend à l'arrivée, `load()` sert aux appels impératifs
// (effets). Un échec est journalisé puis mémorisé en `null` — pas de tempête de retries.
import { useEffect, useSyncExternalStore } from "react";

export interface LazyModule<T> {
  /** Valeur chargée, ou `null` tant que le chunk n'est pas arrivé (ou a échoué). */
  get(): T | null;
  /** Déclenche le chargement (idempotent) et résout sur la valeur, ou `null` en cas d'échec. */
  load(): Promise<T | null>;
  /** Hook : déclenche le chargement au montage et re-rend le composant à l'arrivée. */
  use(): T | null;
}

export function createLazyModule<T>(label: string, loader: () => Promise<T>): LazyModule<T> {
  let value: T | null = null;
  let pending: Promise<T | null> | null = null;
  let version = 0;
  const listeners = new Set<() => void>();

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function snapshot(): number {
    return version;
  }

  function load(): Promise<T | null> {
    if (!pending) {
      pending = loader().then(
        (mod) => {
          value = mod;
          version += 1;
          for (const listener of listeners) listener();
          return mod;
        },
        (err) => {
          console.error(`[lazy] ${label} indisponible`, err);
          return null;
        },
      );
    }
    return pending;
  }

  return {
    get: () => value,
    load,
    use() {
      useSyncExternalStore(subscribe, snapshot, snapshot);
      useEffect(() => {
        void load();
      }, []);
      return value;
    },
  };
}
