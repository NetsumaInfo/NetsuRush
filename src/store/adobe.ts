// Slice Pont Adobe : statut Premiere/AE + snapshots projet poussés par le panneau CEP.
// Le panneau (dans Adobe) lit le projet et l'envoie au core ; ici on ne fait que
// rafraîchir/afficher et déclencher lancement/scan/installation.
import type { StateCreator } from "zustand";
import i18n from "@/i18n";
import { nr } from "@/lib/bridge";
import type { AdobeApp, AdobeBridgeStatus, AdobeSnapshot } from "@/lib/bridge";
import { hostLabel } from "@/lib/host";
import type { AppState } from "./index";

export interface AdobeSlice {
  adobeStatus: AdobeBridgeStatus | null;
  adobeSnapshots: Partial<Record<AdobeApp, AdobeSnapshot | null>>;
  adobeBusy: boolean;
  adobeNotice: { kind: "ok" | "err"; text: string } | null;

  refreshAdobeStatus(): Promise<void>;
  loadAdobeSnapshot(app: AdobeApp): Promise<void>;
  launchAdobe(app: AdobeApp): Promise<void>;
  scanAdobe(app: AdobeApp): Promise<void>;
  installAdobePanel(): Promise<void>;
  setAdobePanelAutoUpdate(on: boolean): Promise<void>;
}

export const createAdobeSlice: StateCreator<AppState, [], [], AdobeSlice> = (set, get) => ({
  adobeStatus: null,
  adobeSnapshots: {},
  adobeBusy: false,
  adobeNotice: null,

  refreshAdobeStatus: async () => {
    try {
      const st = await nr.adobeStatus();
      set({ adobeStatus: st });
    } catch {
      set({ adobeStatus: null });
    }
  },

  loadAdobeSnapshot: async (app) => {
    try {
      const snap = await nr.adobeSnapshot(app);
      set({ adobeSnapshots: { ...get().adobeSnapshots, [app]: snap } });
    } catch {
      /* core injoignable : snapshot inchangé */
    }
  },

  launchAdobe: async (app) => {
    set({ adobeBusy: true, adobeNotice: null });
    try {
      const r = await nr.adobeLaunch(app);
      if (!r.ok) {
        set({ adobeNotice: { kind: "err", text: r.error || i18n.t("adobe:notice.launchFailed") } });
      } else if (r.already) {
        set({ adobeNotice: { kind: "ok", text: i18n.t("adobe:notice.alreadyOpen") } });
      }
      await get().refreshAdobeStatus();
    } finally {
      set({ adobeBusy: false });
    }
  },

  scanAdobe: async (app) => {
    // Demande au panneau (SSE adobe:cmd) de relire le projet ; le résultat
    // revient en adobe:update → le composant recharge le snapshot.
    try {
      await nr.adobeScan(app);
    } catch {
      set({ adobeNotice: { kind: "err", text: i18n.t("adobe:notice.panelUnreachable") } });
    }
  },

  installAdobePanel: async () => {
    set({ adobeBusy: true, adobeNotice: null });
    try {
      const r = await nr.adobeInstallPanel();
      let text: string;
      if (!r.ok) {
        text = r.error || i18n.t("adobe:notice.installFailed");
      } else if (r.restart && r.restart.length) {
        // App déjà ouverte : CEP ne charge le panneau qu'au démarrage → redémarrage obligatoire.
        text = i18n.t("adobe:notice.installedRestart", { apps: r.restart.map(hostLabel).join(" et ") });
      } else {
        text = i18n.t("adobe:notice.installedOpen");
      }
      set({ adobeNotice: { kind: r.ok ? "ok" : "err", text } });
      await get().refreshAdobeStatus();
    } finally {
      set({ adobeBusy: false });
    }
  },

  setAdobePanelAutoUpdate: async (on) => {
    try {
      const r = await nr.adobeSetPanelAutoUpdate(on);
      if (!r.ok) set({ adobeNotice: { kind: "err", text: r.error || i18n.t("adobe:notice.autoUpdateFailed") } });
    } catch {
      set({ adobeNotice: { kind: "err", text: i18n.t("adobe:notice.autoUpdateFailed") } });
    }
    await get().refreshAdobeStatus();
  },
});
