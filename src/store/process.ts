// Slice « Traitements » : mode actif du hub (Upscale | Interpolation | Depth | RemoveBG).
// Le mode est persisté en localStorage. Le ProcMode est défini dans bridge (source unique) — on l'importe.
import type { StateCreator } from "zustand";
import { type ProcMode } from "@/lib/bridge";
import type { AppState } from "./index";

const lsGet = (k: string, def: string) => { try { return localStorage.getItem(k) || def; } catch { return def; } };

// Une valeur persistée peut nommer un mode qui n'existe plus : sans ce filtre l'onglet s'ouvrirait
// sur un mode inconnu (bascule vide, aucun réglage) au lieu de repartir sur l'upscale.
const PROC_MODES: ProcMode[] = ["upscale", "interpolate", "depth", "removebg"];
const readMode = (): ProcMode => {
  const stored = lsGet("nr.process.mode", "upscale") as ProcMode;
  return PROC_MODES.includes(stored) ? stored : "upscale";
};

export interface ProcessSlice {
  procMode: ProcMode;
  setProcMode: (m: ProcMode) => void;
}
export const createProcessSlice: StateCreator<AppState, [], [], ProcessSlice> = (set) => ({
  procMode: readMode(),
  setProcMode: (procMode) => { try { localStorage.setItem("nr.process.mode", procMode); } catch { /* noop */ } set({ procMode }); },
});
