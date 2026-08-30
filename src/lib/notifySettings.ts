// Durées d'affichage des retours d'état : pastilles (succès, erreur) et indicateur d'erreurs du coin
// bas-droit. Réglables par l'utilisateur, en secondes, `0` = ne s'efface pas tout seul.
//
// Module PUR, sans import du store : la pile de pastilles vit HORS React (gestionnaire global) et
// doit lire ces durées depuis un callback asynchrone — d'où l'abonnement ci-dessous plutôt qu'un
// hook. Une pastille de TÂCHE EN COURS n'est pas réglable : c'est son achèvement qui la remplace.

export interface NotifyDurations {
  /** Fin de tâche et messages d'information. */
  ok: number;
  /** Erreurs annoncées en pastille : à lire, donc plus longtemps qu'une réussite. */
  error: number;
  /** Indicateur rouge d'erreurs journalisées (compteur cliquable). */
  badge: number;
}

export const DEFAULT_NOTIFY: NotifyDurations = { ok: 4, error: 8, badge: 20 };

/** Choix proposés dans les Paramètres. `0` = reste jusqu'au clic. */
export const NOTIFY_CHOICES = [2, 4, 6, 10, 15, 20, 30, 60, 0];

const STORAGE_KEY = "nr.notify.v1";

function clean(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return NOTIFY_CHOICES.includes(value) ? value : fallback;
}

function normalize(raw: unknown): NotifyDurations {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<NotifyDurations>;
  return {
    ok: clean(value.ok, DEFAULT_NOTIFY.ok),
    error: clean(value.error, DEFAULT_NOTIFY.error),
    badge: clean(value.badge, DEFAULT_NOTIFY.badge),
  };
}

export function readNotify(): NotifyDurations {
  if (typeof localStorage === "undefined") return { ...DEFAULT_NOTIFY };
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_NOTIFY };
  }
}

let current: NotifyDurations = readNotify();
const listeners = new Set<(value: NotifyDurations) => void>();

/** Durées en vigueur, lisibles hors React (gestionnaire de pastilles). */
export function notifyDurations(): NotifyDurations {
  return current;
}

export function writeNotify(settings: NotifyDurations): NotifyDurations {
  current = normalize(settings);
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  for (const listener of listeners) listener(current);
  return current;
}

/** S'abonner aux changements (l'indicateur d'erreurs recalcule son minuteur en cours de route). */
export function subscribeNotify(listener: (value: NotifyDurations) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
