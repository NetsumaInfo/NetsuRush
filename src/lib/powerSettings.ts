// Préférences de la surface « énergie hôte » (cf. `components/power/PowerPrompt`) : le droit de
// proposer une fermeture au démarrage d'une tâche lourde, le rappel de réouverture, et ce que devient
// une invite réduite. Module PUR, sans import du store : le slice « paramètres » le relaie.
//
// Aucune de ces options ne retire une CAPACITÉ : fermer et rouvrir le logiciel restent dans le menu
// du voyant de la barre latérale. Elles ne règlent que ce que l'app propose d'elle-même.

export interface PowerPromptSettings {
  /** Proposer de fermer le logiciel de montage quand une tâche lourde démarre. */
  offer: boolean;
  /** Rappeler qu'un logiciel fermé par NetsuRush peut être rouvert sur son projet. */
  reopen: boolean;
  /** Réduire une invite la colle au bord droit en languette ; sinon elle disparaît. */
  nub: boolean;
}

export const DEFAULT_POWER_PROMPT: PowerPromptSettings = { offer: true, reopen: true, nub: true };

const STORAGE_KEY = "nr.power.prompt.v1";

function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

export function normalizePowerPrompt(raw: unknown): PowerPromptSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<PowerPromptSettings>;
  return {
    offer: flag(value.offer, DEFAULT_POWER_PROMPT.offer),
    reopen: flag(value.reopen, DEFAULT_POWER_PROMPT.reopen),
    nub: flag(value.nub, DEFAULT_POWER_PROMPT.nub),
  };
}

export function readPowerPrompt(): PowerPromptSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_POWER_PROMPT };
  try {
    return normalizePowerPrompt(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_POWER_PROMPT };
  }
}

export function writePowerPrompt(settings: PowerPromptSettings): PowerPromptSettings {
  const clean = normalizePowerPrompt(settings);
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}
