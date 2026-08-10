import type { TabId } from "@/store/types";
import { modelById, type ModelTask } from "@/lib/modelRegistry";

export const MODULE_IDS = [
  "derush",
  "search",
  "reference",
  "notebook",
  "script",
  "upscale",
  "voice",
  "chat",
  "optimisation",
  "transfer",
] as const satisfies readonly TabId[];

export type ModuleId = (typeof MODULE_IDS)[number];

export const REQUIRED_MODULES: readonly ModuleId[] = ["derush"];

const MODULE_MODEL_TASKS: Partial<Record<ModuleId, readonly ModelTask[]>> = {
  derush: ["detect"],
  search: ["search", "face"],
  upscale: ["upscale", "restore", "interpolate", "depth", "matte-video", "matte-image", "segment", "object-removal"],
  voice: ["voice-asr", "voice-vad"],
};

const MODULE_BY_TASK = new Map<ModelTask, ModuleId>(
  Object.entries(MODULE_MODEL_TASKS).flatMap(([moduleId, tasks]) =>
    (tasks ?? []).map((task) => [task, moduleId as ModuleId] as const),
  ),
);

/**
 * Modules dont les dépendances Python doivent être provisionnées pour les modèles choisis.
 * L'installation ne demande plus quelles PAGES afficher (elles le sont toutes, la barre latérale se
 * règle dans les Paramètres) : le seul choix qui coûte du disque est celui des modèles, et c'est lui
 * qui dicte les étapes lourdes de `scripts/setup.ps1` (voix, traitements…).
 */
export function modulesForModels(models: readonly string[]): ModuleId[] {
  const needed = new Set<ModuleId>(REQUIRED_MODULES);
  for (const id of models) {
    const task = modelById(id)?.task;
    const moduleId = task ? MODULE_BY_TASK.get(task) : undefined;
    if (moduleId) needed.add(moduleId);
  }
  return MODULE_IDS.filter((id) => needed.has(id));
}

const MODULE_PREFS_KEY = "nr.modules.v2";

export interface ModulePreferences {
  order: ModuleId[];
  hidden: ModuleId[];
}

function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}

function normalizeModuleOrder(value: unknown): ModuleId[] {
  const provided = Array.isArray(value) ? value.filter(isModuleId) : [];
  return [...new Set([...provided, ...MODULE_IDS])];
}

export function normalizeHiddenModules(value: unknown): ModuleId[] {
  if (!Array.isArray(value)) return [];
  const required = new Set(REQUIRED_MODULES);
  return [...new Set(value.filter(isModuleId))].filter((id) => !required.has(id));
}

export function loadModulePreferences(): ModulePreferences {
  try {
    const raw = localStorage.getItem(MODULE_PREFS_KEY);
    if (!raw) return { order: [...MODULE_IDS], hidden: [] };
    const parsed = JSON.parse(raw) as Partial<ModulePreferences>;
    return {
      order: normalizeModuleOrder(parsed.order),
      hidden: normalizeHiddenModules(parsed.hidden),
    };
  } catch {
    return { order: [...MODULE_IDS], hidden: [] };
  }
}

export function saveModulePreferences(preferences: ModulePreferences): void {
  try {
    localStorage.setItem(MODULE_PREFS_KEY, JSON.stringify({
      order: normalizeModuleOrder(preferences.order),
      hidden: normalizeHiddenModules(preferences.hidden),
    }));
  } catch {
    // Le store reste utilisable quand le stockage du webview est indisponible.
  }
}

export function enabledFromHidden(hidden: readonly ModuleId[]): ModuleId[] {
  const hiddenSet = new Set(hidden);
  return MODULE_IDS.filter((id) => !hiddenSet.has(id));
}
