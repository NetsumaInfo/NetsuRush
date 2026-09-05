// Slice « Chat IA » : état de la conversation, moteur (provider/agent/modèle), mode de permission,
// approbation en attente, et ingestion des événements normalisés (SSE chat:event) en messages d'UI.
import type { StateCreator } from "zustand";
import { nr, type ChatProvider, type ChatPermMode, type ChatAgentsInfo, type ChatApprovalReq, type ChatEvent, type ChatMessage, type ChatConvMeta } from "@/lib/bridge";
import type { AppState } from "./index";
import i18n from "@/i18n";
import { systemPromptFor } from "@/lib/agentPrompts";

export interface UiToolCall { id: string; name: string; input: unknown; ok?: boolean; result?: unknown; done: boolean }
export interface UiMessage { id: string; role: "user" | "assistant"; content: string; thinking: string; tools: UiToolCall[] }

// Préférences persistées (localStorage) — choix du moteur, hors flux de conversation.
const lsGet = (k: string, fallback: string) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export interface ChatSlice {
  chatProvider: ChatProvider;
  chatAgentId: string;
  chatModel: string;
  chatMode: ChatPermMode;
  chatAgents: ChatAgentsInfo | null;
  chatKeysSet: { anthropic: boolean; openai: boolean; openrouter: boolean; xai: boolean };
  chatMessages: UiMessage[];
  chatRunning: boolean;
  chatRunId: string | null;
  chatApproval: ChatApprovalReq | null;
  chatStatus: string;
  chatError: string | null;
  chatConvs: ChatConvMeta[];    // conversations sauvegardées (méta)
  chatConvId: string | null;    // conversation courante (null = nouvelle, non encore sauvée)

  chatLoadConvs: () => Promise<void>;
  chatNewConv: () => void;
  chatOpenConv: (id: string) => Promise<void>;
  chatDeleteConv: (id: string) => Promise<void>;
  chatPersist: () => Promise<void>;
  setChatProvider: (p: ChatProvider) => void;
  setChatAgentId: (id: string) => void;
  setChatModel: (m: string) => void;
  setChatMode: (m: ChatPermMode) => void;
  chatLoadAgents: () => Promise<void>;
  chatConfigureKeys: (cfg: { anthropicKey?: string; openaiKey?: string; openrouterKey?: string; xaiKey?: string }) => Promise<void>;
  chatSend: (text: string) => void;
  chatCancel: () => void;
  chatRespondApproval: (approved: boolean) => void;
  chatIngest: (e: { runId: string; ev: ChatEvent }) => void;
  chatSetApproval: (r: ChatApprovalReq | null) => void;
  chatClear: () => void;
}

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set, get) => ({
  chatProvider: lsGet("nr-chat-provider", "anthropic") as ChatProvider,
  chatAgentId: lsGet("nr-chat-agent", "claude"),
  chatModel: lsGet("nr-chat-model", ""),
  chatMode: lsGet("nr-chat-mode", "ask") as ChatPermMode,
  chatAgents: null,
  chatKeysSet: { anthropic: false, openai: false, openrouter: false, xai: false },
  chatMessages: [],
  chatRunning: false,
  chatRunId: null,
  chatApproval: null,
  chatStatus: "",
  chatError: null,
  chatConvs: [],
  chatConvId: null,

  chatLoadConvs: async () => {
    const list = await nr.chat?.history.list();
    if (list) set({ chatConvs: list });
  },

  chatNewConv: () => {
    if (get().chatRunning) get().chatCancel();
    set({ chatMessages: [], chatConvId: null, chatError: null, chatStatus: "" });
  },

  chatOpenConv: async (id) => {
    if (get().chatRunning) get().chatCancel();
    const c = await nr.chat?.history.load(id);
    if (!c) return;
    set({
      chatConvId: c.id,
      chatMessages: c.messages.map((m) => ({ id: uid(), role: m.role, content: m.content, thinking: "", tools: [] })),
      chatError: null, chatStatus: "",
    });
  },

  chatDeleteConv: async (id) => {
    await nr.chat?.history.delete(id);
    if (get().chatConvId === id) get().chatNewConv();
    await get().chatLoadConvs();
  },

  // Sauve la conversation courante (fin de tour). Titre = début du 1er message utilisateur.
  chatPersist: async () => {
    const { chatMessages, chatConvId } = get();
    if (!chatMessages.length) return;
    const firstUser = chatMessages.find((m) => m.role === "user");
    const fallbackTitle = i18n.t("chat:header.defaultTitle");
    const title = (firstUser?.content || fallbackTitle).trim().slice(0, 48) || fallbackTitle;
    const messages: ChatMessage[] = chatMessages.map((m) => ({ role: m.role, content: m.content }));
    const r = await nr.chat?.history.save({ id: chatConvId ?? undefined, title, messages });
    if (r?.id && r.id !== chatConvId) set({ chatConvId: r.id });
    await get().chatLoadConvs();
  },

  setChatProvider: (chatProvider) => { lsSet("nr-chat-provider", chatProvider); set({ chatProvider }); },
  setChatAgentId: (chatAgentId) => { lsSet("nr-chat-agent", chatAgentId); set({ chatAgentId }); },
  setChatModel: (chatModel) => { lsSet("nr-chat-model", chatModel); set({ chatModel }); },
  setChatMode: (chatMode) => {
    lsSet("nr-chat-mode", chatMode);
    set({ chatMode });
    void nr.chat?.configure({ mode: chatMode });
  },

  chatLoadAgents: async () => {
    const info = await nr.chat?.agents();
    if (!info) return;
    set({ chatAgents: info, chatKeysSet: { anthropic: info.byok.anthropic, openai: info.byok.openai, openrouter: info.byok.openrouter, xai: info.byok.xai } });
    // Le choix local (persisté) est la source de vérité du mode → on le (re)pousse au core.
    void nr.chat?.configure({ mode: get().chatMode });

    // Auto-sélection : si le moteur courant n'est pas prêt mais qu'un autre l'est, basculer dessus.
    const cliAvail = (info.cli || []).filter((a) => a.available);
    const isReady = (p: ChatProvider) =>
      p === "anthropic" ? info.byok.anthropic
        : p === "openai" ? info.byok.openai
        : p === "openrouter" ? info.byok.openrouter
        : p === "xai" ? info.byok.xai
        : cliAvail.length > 0;
    if (!isReady(get().chatProvider)) {
      const pick = (["cli", "anthropic", "openai", "openrouter", "xai"] as ChatProvider[]).find(isReady);
      if (pick) get().setChatProvider(pick);
    }
    // S'assurer qu'un agent CLI VALIDE est sélectionné quand le moteur est CLI.
    if (get().chatProvider === "cli" && cliAvail.length && !cliAvail.some((a) => a.id === get().chatAgentId)) {
      get().setChatAgentId(cliAvail[0].id);
    }
  },

  chatConfigureKeys: async (cfg) => {
    await nr.chat?.configure(cfg);
    const cur = get().chatKeysSet;
    set({
      chatKeysSet: {
        anthropic: cfg.anthropicKey != null ? !!cfg.anthropicKey : cur.anthropic,
        openai: cfg.openaiKey != null ? !!cfg.openaiKey : cur.openai,
        openrouter: cfg.openrouterKey != null ? !!cfg.openrouterKey : cur.openrouter,
        xai: cfg.xaiKey != null ? !!cfg.xaiKey : cur.xai,
      },
    });
  },

  chatSend: (text) => {
    const t = text.trim();
    if (!t || get().chatRunning) return;
    const { chatProvider, chatAgentId, chatModel, chatMessages } = get();
    const history: ChatMessage[] = chatMessages.map((m) => ({ role: m.role, content: m.content }));
    const userMsg: UiMessage = { id: uid(), role: "user", content: t, thinking: "", tools: [] };
    const asstMsg: UiMessage = { id: uid(), role: "assistant", content: "", thinking: "", tools: [] };
    const runId = uid();
    set({ chatMessages: [...chatMessages, userMsg, asstMsg], chatRunning: true, chatRunId: runId, chatError: null, chatStatus: "" });
    const messages: ChatMessage[] = [...history, { role: "user", content: t }];
    nr.chat?.send({
      runId, provider: chatProvider, agent: chatAgentId, model: chatModel || undefined, messages,
      // The surface picks BOTH the prompt and the tool set the engine offers.
      // Sending one without the other would describe capabilities the model has
      // not been given, which is the fastest way to make it invent them.
      surface: "pilot", system: systemPromptFor("pilot"),
    })
      .catch((e) => set({ chatError: String(e), chatRunning: false, chatRunId: null }));
  },

  chatCancel: () => {
    const { chatRunId } = get();
    if (chatRunId) void nr.chat?.cancel(chatRunId);
    set({ chatRunning: false, chatRunId: null, chatStatus: "" });
  },

  chatRespondApproval: (approved) => {
    const a = get().chatApproval;
    if (a) void nr.chat?.respondApproval(a.callId, approved);
    set({ chatApproval: null });
  },

  chatSetApproval: (chatApproval) => set({ chatApproval }),

  chatIngest: ({ runId, ev }) => {
    const st = get();
    if (st.chatRunId && runId !== st.chatRunId) return; // événement d'un autre run
    const msgs = st.chatMessages.slice();
    // dernier message assistant (placeholder du tour courant)
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { idx = i; break; }
    const patch = (fn: (m: UiMessage) => UiMessage) => { if (idx >= 0) { msgs[idx] = fn(msgs[idx]); set({ chatMessages: msgs }); } };

    switch (ev.type) {
      case "text": patch((m) => ({ ...m, content: m.content + (ev.delta || "") })); break;
      case "thinking": patch((m) => ({ ...m, thinking: m.thinking + (ev.delta || "") })); break;
      case "status": set({ chatStatus: ev.label || "" }); break;
      case "tool_use":
        patch((m) => ({ ...m, tools: [...m.tools, { id: ev.id || uid(), name: ev.name || "", input: ev.input, done: false }] }));
        break;
      case "tool_result":
        patch((m) => ({ ...m, tools: m.tools.map((tc) => (tc.id === ev.id ? { ...tc, ok: ev.ok, result: ev.content, done: true } : tc)) }));
        break;
      case "error": set({ chatError: ev.message || i18n.t("chat:stream.error") }); break;
      case "done": set({ chatRunning: false, chatRunId: null, chatStatus: "" }); void get().chatPersist(); break;
      default: break;
    }
  },

  chatClear: () => set({ chatMessages: [], chatError: null, chatStatus: "" }),
});
