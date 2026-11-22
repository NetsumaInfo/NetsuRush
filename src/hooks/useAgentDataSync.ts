// An external agent wrote app data through MCP: refetch the renderer store that mirrors it.
// Several tool calls usually land back to back, so refetches are coalesced per tool.
import { useEffect } from "react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";

const REFETCH_DEBOUNCE_MS = 300;

type Refetch = () => void;

const REFETCH_BY_TOOL: Record<string, Refetch> = {
  netsu_library: () => { void useApp.getState().loadLibrary(); },
  netsu_collections: () => {
    const state = useApp.getState();
    void state.loadCollections();
    void state.loadCollectionFolders();
    void state.loadCollectionTags();
  },
  netsu_notebook: () => {
    const state = useApp.getState();
    void state.nbLoadList();
    if (state.nbActiveId) void state.nbOpenNotebook(state.nbActiveId);
  },
};

export function useAgentDataSync() {
  useEffect(() => {
    const timers = new Map<string, number>();
    const off = nr.mcp?.onDataChanged(({ tool }) => {
      const refetch = REFETCH_BY_TOOL[tool];
      if (!refetch) return;
      window.clearTimeout(timers.get(tool));
      timers.set(tool, window.setTimeout(() => { timers.delete(tool); refetch(); }, REFETCH_DEBOUNCE_MS));
    });
    return () => {
      off?.();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);
}
