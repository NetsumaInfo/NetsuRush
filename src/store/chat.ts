// Slice « Chat IA » : état de la conversation, moteur (provider/agent/modèle), mode de permission,
// approbation en attente, et ingestion des événements normalisés (SSE chat:event) en messages d'UI.
import type { StateCreator } from "zustand";
import { nr, type ChatProvider, type ChatPermMode, type ChatAgentsInfo, type ChatApprovalReq, type ChatEvent, type ChatMessage, type ChatConvMeta, type ChatModelList, type ChatThinking } from "@/lib/bridge";
import type { AppState } from "./index";
import i18n from "@/i18n";
import { systemPromptFor } from "@/lib/agentPrompts";
import { buildEngines, toEngineId, toWire } from "@/lib/agentCatalog";

export interface UiToolCall {
  id: string; name: string; input: unknown; ok?: boolean; result?: unknown; done: boolean;
  startedAt: number; endedAt?: number;
}
/**
 * Une étape du tour, dans l'ORDRE où elle est arrivée.
 *
 * `thinking` et `tools` disent CE QUI s'est passé mais pas QUAND : un modèle
 * qui réfléchit, appelle un outil, re-réfléchit, en rappelle un autre se
 * relisait comme un bloc de pensée d'un côté et une pile d'outils de l'autre.
 * La trace a besoin de la chronologie ; le texte reste dupliqué dans
 * `thinking` pour les vues qui ne lisent que lui.
 */
export type UiStep =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; id: string };
export interface UiMessage {
  id: string; role: "user" | "assistant"; content: string; thinking: string;
  tools: UiToolCall[]; steps: UiStep[];
  /** Bornes du tour, pour dire « réfléchi pendant N s » au lieu de rien. */
  startedAt?: number; endedAt?: number;
}

// Préférences persistées (localStorage) — choix du moteur, hors flux de conversation.
const lsGet = (k: string, fallback: string) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export interface ChatSlice {
  chatProvider: ChatProvider;
  chatAgentId: string;
  chatModel: string;
  chatMode: ChatPermMode;
  /** Reasoning effort, for the engines that accept one. */
  chatThinking: ChatThinking;
  /** Duplicate the timeline before the first write of a turn. Orthogonal to the mode. */
  chatDuplicateFirst: boolean;
  /** Expose `bmd_run_script_unsafe` (Resolve MCP), which runs outside the sandbox. */
  chatResolveUnsafe: boolean;
  chatAgents: ChatAgentsInfo | null;
  /** Model lists per provider, as fetched. Keyed by `modelsFrom`, not by engine. */
  chatModels: Record<string, ChatModelList>;
  chatModelsBusy: string | null;
  /** When detection last ran, so opening a menu can refresh without re-probing on every click. */
  chatAgentsAt: number;
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
  /** One choice instead of two: `cli:codex` or `api:anthropic`. */
  setChatEngine: (engineId: string) => void;
  chatLoadModels: (provider: string, refresh?: boolean) => Promise<void>;
  setChatModel: (m: string) => void;
  setChatMode: (m: ChatPermMode) => void;
  setChatThinking: (t: ChatThinking) => void;
  setChatDuplicateFirst: (on: boolean) => void;
  setChatResolveUnsafe: (on: boolean) => void;
  chatLoadAgents: () => Promise<void>;
  /** Re-probes only if the last scan is stale. For opening a menu. */
  chatEnsureAgents: (maxAgeMs?: number) => void;
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
  // « medium » par defaut, et le cran « aucune » n'existe plus : ces moteurs
  // ne se pilotent pas sans reflexion. Un « off » enregistre par une version
  // anterieure retombe ici, le core le normalisant de son cote.
  chatThinking: (["low", "medium", "high", "xhigh", "max"].includes(lsGet("nr-chat-thinking", ""))
    ? lsGet("nr-chat-thinking", "medium")
    : "medium") as ChatThinking,
  // Off by default: duplicating unasked leaves orphan timelines in the project.
  chatDuplicateFirst: lsGet("nr-chat-duplicate", "0") === "1",
  // Off by default, and deliberately not a risk setting: the tool it registers
  // reaches the disk, the network and subprocesses, which no permission mode of
  // ours can hold back once its script is running.
  chatResolveUnsafe: lsGet("nr-chat-resolve-unsafe", "0") === "1",
  chatAgents: null,
  chatModels: {},
  chatModelsBusy: null,
  chatAgentsAt: 0,
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
      chatMessages: c.messages.map((m) => ({ id: uid(), role: m.role, content: m.content, thinking: "", tools: [], steps: [] })),
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

  // Changer de moteur remet le modele a « par defaut » : un identifiant tape
  // pour Claude Code n'a aucun sens pour Codex, et le garder produirait un
  // appel rejete que rien dans l'ecran n'expliquerait.
  setChatEngine: (engineId) => {
    const { provider, agent } = toWire(engineId);
    lsSet("nr-chat-provider", provider);
    if (agent) lsSet("nr-chat-agent", agent);
    lsSet("nr-chat-model", "");
    set({ chatProvider: provider, ...(agent ? { chatAgentId: agent } : {}), chatModel: "" });
  },

  // Liste de modeles d'un fournisseur. Le core sait d'ou la tirer (API du
  // fournisseur si une cle est posee, catalogue public sinon) ; l'UI ne fait
  // que demander et se souvenir.
  chatLoadModels: async (provider, refresh) => {
    if (!provider) return;
    if (!refresh && get().chatModels[provider]) return;
    set({ chatModelsBusy: provider });
    try {
      const list = await nr.chat?.models({ provider, refresh: !!refresh });
      if (list) set({ chatModels: { ...get().chatModels, [provider]: list } });
    } catch { /* liste indisponible : le champ libre reste ouvert */ }
    finally { if (get().chatModelsBusy === provider) set({ chatModelsBusy: null }); }
  },
  setChatMode: (chatMode) => {
    lsSet("nr-chat-mode", chatMode);
    set({ chatMode });
    void nr.chat?.configure({ mode: chatMode });
  },

  setChatThinking: (chatThinking) => { lsSet("nr-chat-thinking", chatThinking); set({ chatThinking }); },

  setChatDuplicateFirst: (chatDuplicateFirst) => {
    lsSet("nr-chat-duplicate", chatDuplicateFirst ? "1" : "0");
    set({ chatDuplicateFirst });
    void nr.chat?.configure({ duplicateFirst: chatDuplicateFirst });
  },

  // Le core RE-INTERROGE le serveur MCP de Blackmagic pour ajouter ou retirer
  // l'outil : la liste rechargee ensuite est celle d'apres le changement, pas
  // celle d'avant.
  setChatResolveUnsafe: async (chatResolveUnsafe) => {
    lsSet("nr-chat-resolve-unsafe", chatResolveUnsafe ? "1" : "0");
    set({ chatResolveUnsafe });
    await nr.chat?.configure({ resolveUnsafe: chatResolveUnsafe });
    await get().chatLoadAgents();
  },

  // Detection est PARESSEUSE : elle lance une dizaine de sondes de processus,
  // chacune avec son delai d'attente. Ce garde-fou est ce qui permet de la
  // declencher a l'ouverture d'un menu sans la relancer a chaque clic.
  chatEnsureAgents: (maxAgeMs = 30_000) => {
    if (Date.now() - get().chatAgentsAt < maxAgeMs) return;
    void get().chatLoadAgents();
  },

  chatLoadAgents: async () => {
    // Poser l'horodatage AVANT l'attente : deux panneaux qui montent ensemble
    // lanceraient sinon deux detections completes en parallele.
    set({ chatAgentsAt: Date.now() });
    const info = await nr.chat?.agents();
    if (!info) return;
    set({ chatAgents: info, chatKeysSet: { anthropic: info.byok.anthropic, openai: info.byok.openai, openrouter: info.byok.openrouter, xai: info.byok.xai } });
    // Le choix local (persisté) est la source de vérité du mode → on le (re)pousse au core.
    // Idem pour l'outil hors bac à sable du serveur Resolve : le core démarre
    // sans lui, et c'est ce réglage qui décide s'il doit être enregistré.
    void nr.chat?.configure({ mode: get().chatMode, resolveUnsafe: get().chatResolveUnsafe });

    // Auto-selection, en un seul raisonnement : si le moteur retenu n'est plus
    // la (agent desinstalle, cle retiree), prendre le premier qui tourne. La
    // version d'avant traitait « quel fournisseur » et « quel agent » comme
    // deux questions, et pouvait donc s'arreter sur un couple invalide.
    const engines = buildEngines(info);
    const current = toEngineId(get().chatProvider, get().chatAgentId);
    if (!engines.some((e) => e.id === current && e.ready)) {
      const pick = engines.find((e) => e.ready);
      if (pick) get().setChatEngine(pick.id);
    }

    // Charger la liste de modeles du moteur retenu, pour que le menu ne
    // s'ouvre pas sur un vide le temps d'un aller-retour reseau.
    const engine = engines.find((e) => e.id === toEngineId(get().chatProvider, get().chatAgentId));
    if (engine) void get().chatLoadModels(engine.modelsFrom);
  },

  chatConfigureKeys: async (cfg) => {
    await nr.chat?.configure(cfg);
    // Une cle posee fait passer la liste de l'approximation publique aux
    // identifiants exacts du fournisseur : le cache local doit ceder.
    set({ chatModels: {} });
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
    const { chatProvider, chatAgentId, chatModel, chatMessages, chatThinking } = get();
    const history: ChatMessage[] = chatMessages.map((m) => ({ role: m.role, content: m.content }));
    const userMsg: UiMessage = { id: uid(), role: "user", content: t, thinking: "", tools: [], steps: [] };
    const asstMsg: UiMessage = { id: uid(), role: "assistant", content: "", thinking: "", tools: [], steps: [], startedAt: Date.now() };
    const runId = uid();
    set({ chatMessages: [...chatMessages, userMsg, asstMsg], chatRunning: true, chatRunId: runId, chatError: null, chatStatus: "" });
    const messages: ChatMessage[] = [...history, { role: "user", content: t }];
    nr.chat?.send({
      runId, provider: chatProvider, agent: chatAgentId, model: chatModel || undefined, messages,
      thinking: chatThinking,
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
    // Strict: an event only belongs here when this store owns the run. The
    // guard used to let anything through while `chatRunId` was null, so a turn
    // started in the NetsuFlow panel poured its reasoning, its tools and its
    // status into NetsuPilot's last message — and got persisted there.
    if (!st.chatRunId || runId !== st.chatRunId) return;
    const msgs = st.chatMessages.slice();
    // dernier message assistant (placeholder du tour courant)
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { idx = i; break; }
    const patch = (fn: (m: UiMessage) => UiMessage) => { if (idx >= 0) { msgs[idx] = fn(msgs[idx]); set({ chatMessages: msgs }); } };

    switch (ev.type) {
      case "text": patch((m) => ({ ...m, content: m.content + (ev.delta || "") })); break;
      case "thinking":
        // Les fragments s'agrègent dans l'étape de raisonnement EN COURS. Une
        // nouvelle étape ne s'ouvre qu'après un outil : c'est ce qui distingue
        // « il a réfléchi, agi, puis re-réfléchi » d'un pavé unique.
        patch((m) => {
          const delta = ev.delta || "";
          const steps = m.steps.slice();
          const last = steps[steps.length - 1];
          if (last?.kind === "reasoning") steps[steps.length - 1] = { kind: "reasoning", text: last.text + delta };
          else steps.push({ kind: "reasoning", text: delta });
          return { ...m, thinking: m.thinking + delta, steps };
        });
        break;
      case "status": set({ chatStatus: ev.label || "" }); break;
      case "tool_use":
        patch((m) => {
          const id = ev.id || uid();
          return {
            ...m,
            tools: [...m.tools, { id, name: ev.name || "", input: ev.input, done: false, startedAt: Date.now() }],
            steps: [...m.steps, { kind: "tool", id }],
          };
        });
        break;
      case "tool_result":
        patch((m) => ({
          ...m,
          tools: m.tools.map((tc) => (tc.id === ev.id
            ? { ...tc, ok: ev.ok, result: ev.content, done: true, endedAt: Date.now() }
            : tc)),
        }));
        break;
      case "error": set({ chatError: ev.message || i18n.t("chat:stream.error") }); break;
      case "done":
        patch((m) => ({ ...m, endedAt: Date.now() }));
        set({ chatRunning: false, chatRunId: null, chatStatus: "" });
        void get().chatPersist();
        break;
      default: break;
    }
  },

  chatClear: () => set({ chatMessages: [], chatError: null, chatStatus: "" }),
});
