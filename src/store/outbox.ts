// Slice « cache projet » : miroir renderer de la file d'attente des envois différés (hôte fermé).
// L'état vit côté core (persistant) ; ici on l'expose au renderer + on relaie les réglages/actions.
import type { StateCreator } from "zustand";
import { nr, type OutboxState, type OutboxSettings, type OutboxHost } from "@/lib/bridge";
import type { AppState } from "./index";

export interface OutboxSlice {
  outbox: OutboxState | null;
  loadOutbox: () => Promise<void>;
  // Charge + s'abonne au SSE `outbox:changed` (renvoie le désabonnement). Appelé une fois par l'App.
  subscribeOutbox: () => () => void;
  outboxSetSettings: (patch: Partial<OutboxSettings>) => Promise<void>;
  outboxRemove: (id: string) => Promise<void>;
  outboxClear: (which?: "all" | "done" | "pending") => Promise<void>;
  outboxFlush: (host?: OutboxHost) => Promise<void>;
}

export const createOutboxSlice: StateCreator<AppState, [], [], OutboxSlice> = (set, get) => ({
  outbox: null,
  loadOutbox: async () => { const s = await nr.outbox?.list(); if (s) set({ outbox: s }); },
  subscribeOutbox: () => {
    void get().loadOutbox();
    return nr.outbox?.onChanged((s) => set({ outbox: s })) ?? (() => {});
  },
  outboxSetSettings: async (patch) => {
    const r = await nr.outbox?.setSettings(patch);
    if (r?.settings) set((st) => (st.outbox ? { outbox: { ...st.outbox, settings: r.settings } } : {}));
  },
  outboxRemove: async (id) => { await nr.outbox?.remove(id); await get().loadOutbox(); },
  outboxClear: async (which) => { await nr.outbox?.clear(which); await get().loadOutbox(); },
  outboxFlush: async (host) => { await nr.outbox?.flush(host); await get().loadOutbox(); },
});
