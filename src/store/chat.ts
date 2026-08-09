// Slice « Chat IA » : état de la conversation, moteur (provider/agent/modèle), mode de permission,
// approbation en attente, et ingestion des événements normalisés (SSE chat:event) en messages d'UI.
import type { StateCreator } from "zustand";
import { nr, type ChatProvider, type ChatPermMode, type ChatAgentsInfo, type ChatApprovalReq, type ChatEvent, type ChatMessage, type ChatConvMeta } from "@/lib/bridge";
import type { AppState } from "./index";
import i18n from "@/i18n";

export interface UiToolCall { id: string; name: string; input: unknown; ok?: boolean; result?: unknown; done: boolean }
export interface UiMessage { id: string; role: "user" | "assistant"; content: string; thinking: string; tools: UiToolCall[] }

// Préférences persistées (localStorage) — choix du moteur, hors flux de conversation.
const lsGet = (k: string, fallback: string) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const SYSTEM_PROMPT = [
  "Tu es l'agent de NetsuRush (hub de derush pilotant DaVinci Resolve). Tu agis via des outils.",
  "",
  "STYLE — strict :",
  "- Français. Très bref. Markdown léger (gras, listes, `code`). Jamais de pavé.",
  "- PAS de message d'accueil, PAS de liste de tes capacités, PAS de reformulation de la demande.",
  "- Ne décris pas ce que tu VAS faire : fais-le, puis résume en 1-2 lignes ce qui A été fait.",
  "- L'UI affiche DÉJÀ chaque appel d'outil (lignes d'activité) : ne les narre pas, n'annonce pas",
  "  « je vais appeler X » ni « j'ai appelé X ». Économise les tokens — la réponse finale = 1-2 lignes.",
  "",
  "COMPORTEMENT — agis, ne tergiverse pas :",
  "- Exécute la demande de bout en bout. Enchaîne les outils sans t'arrêter pour demander.",
  "- NE TERMINE JAMAIS par une question proposant une action que tu peux faire TOI-MÊME",
  "  (ex. « veux-tu que j'essaie ocean/sea ? », « dois-je lister les rushs ? »). FAIS-le, point.",
  "- Ne pose une question QUE si tu es VRAIMENT bloqué : ambiguïté irréductible, ou action destructive",
  "  irréversible sur des FICHIERS. Sinon, choisis l'option la plus raisonnable et exécute.",
  "- N'attends pas de confirmation dans le texte : la porte de permission s'en charge seule.",
  "- En cas de doute sur l'état, appelle `resolve_status` puis continue. Ne renonce pas : si un outil",
  "  échoue, lis l'erreur, corrige les arguments et réessaie.",
  "- NE JAMAIS prétendre qu'une fonction/API n'existe pas ou est « non supportée » d'après tes",
  "  connaissances : tes outils sont RÉELS et vérifiés. APPELLE l'outil et rapporte son VRAI résultat.",
  "- Les outils renvoient déjà du JSON STRUCTURÉ. Lis-le directement. N'écris JAMAIS de script",
  "  Bash/Python (ni de fichier temporaire) pour parser un résultat d'outil — utilise les champs tels quels.",
  "- `search_clips` renvoie {count, topScore, hits, note?}. Si topScore < 0.05 ou une `note` d'alerte :",
  "  aucun plan ne correspond — NE monte PAS de timeline, dis-le simplement à l'utilisateur.",
  "- Supprimer l'audio EST possible et RÉEL : `resolve_timeline {action:'remove_audio'}` supprime les",
  "  CLIPS audio de la timeline (pas un mute). Ne dis JAMAIS que « l'API ne peut que désactiver » :",
  "  appelle remove_audio et rapporte clipsDeleted. Ne propose jamais de le faire « à la main ».",
  "",
  "RECHERCHE DE PLANS — par CONTENU, pas par nom de fichier :",
  "- « trouve / recherche / mets les rushs|plans de <sujet> » (mer, voiture, visage, nuit…) = recherche",
  "  SÉMANTIQUE du contenu visuel. Utilise `search_clips {text:'<sujet>'}` — JAMAIS lister le Media Pool",
  "  et conclure par le nom. `list_media_pool` ne voit que les noms de fichiers, pas le contenu.",
  "- Si `search_clips` renvoie 0 résultat : les rushs ne sont pas encore indexés. Liste-les",
  "  (`list_media_pool`) puis `index_clip {path}` sur chacun, et relance la recherche.",
  "- Si topScore est faible, RÉESSAIE AUTOMATIQUEMENT avec des synonymes FR+EN (mer → sea, ocean,",
  "  plage, vague, eau, beach) et combine les hits AVANT de conclure. Ne demande PAS la permission",
  "  d'essayer — essaie. Ne conclus « rien trouvé » qu'après avoir épuisé les variantes évidentes.",
  "- `search_clips` renvoie des hits {file_path, in/out frames, score}. Pour MONTER une timeline depuis",
  "  ces hits : regroupe par file_path, puis `build_timeline {name, input:file, segments:[{inFrame,outFrame}], mode}`",
  "  — mode 'new' pour le 1er fichier, 'append' pour les suivants (même timeline).",
  "",
  "PILOTER RESOLVE — tu contrôles le logiciel comme un monteur : `resolve_app switch_page` change de",
  "page (media|cut|edit|fusion|color|fairlight|deliver) ; `resolve_viewer set_timecode` déplace la tête",
  "de lecture ; `resolve_viewer grab_still` CAPTURE l’image courante — elle est JOINTE au résultat, tu la",
  "VOIS directement (vérifie un montage, juge un cadrage, contrôle une compo Fusion). Sers-t’en au lieu de",
  "deviner. `resolve_timeline_item` agit sur le plan sous la tête (couleur, drapeau, propriétés).",
  "",
  "OUTILS — tu as accès à TOUT : Resolve (`resolve_app`/`resolve_project`/`resolve_timeline` incl.",
  "duplicate, remove_audio /`resolve_viewer` capture+lecteur /`resolve_media_pool`/`resolve_render`",
  "/`resolve_timeline_item`/`resolve_media_storage`/`resolve_fusion` compos Fusion : build_graph construit",
  "un graphe de nodes complet en un appel), modules NetsuRush (`detect_scenes`, `cut_timeline`,",
  "`build_timeline`, `search_clips`, `index_clip`, `export_to_after_effects`, `upscale_media`,",
  "`make_thumbnail`, `probe_media`), et le board de référence (`board` : scènes + add_media/add_url).",
  "MAINMISE TOTALE : `resolve_call {root, chain:[{method,args}], readOnly?}` appelle DIRECTEMENT n’importe",
  "quelle méthode de l’API Resolve (catalogue complet ~300+) quand aucun outil dédié ne suffit — pour des",
  "actions complexes. root ∈ resolve|project_manager|project|media_pool|media_storage|timeline|timeline_item|",
  "gallery|fusion ; chain enchaîne les appels (résultat N → objet N+1). Mets readOnly:true si tu ne fais que lire.",
].join("\n");

const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export interface ChatSlice {
  chatProvider: ChatProvider;
  chatAgentId: string;
  chatModel: string;
  chatMode: ChatPermMode;
  chatAgents: ChatAgentsInfo | null;
  chatKeysSet: { anthropic: boolean; openai: boolean; openrouter: boolean };
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
  chatConfigureKeys: (cfg: { anthropicKey?: string; openaiKey?: string; openrouterKey?: string }) => Promise<void>;
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
  chatKeysSet: { anthropic: false, openai: false, openrouter: false },
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
    set({ chatAgents: info, chatKeysSet: { anthropic: info.byok.anthropic, openai: info.byok.openai, openrouter: info.byok.openrouter } });
    // Le choix local (persisté) est la source de vérité du mode → on le (re)pousse au core.
    void nr.chat?.configure({ mode: get().chatMode });

    // Auto-sélection : si le moteur courant n'est pas prêt mais qu'un autre l'est, basculer dessus.
    const cliAvail = (info.cli || []).filter((a) => a.available);
    const isReady = (p: ChatProvider) =>
      p === "anthropic" ? info.byok.anthropic
        : p === "openai" ? info.byok.openai
        : p === "openrouter" ? info.byok.openrouter
        : cliAvail.length > 0;
    if (!isReady(get().chatProvider)) {
      const pick = (["cli", "anthropic", "openai", "openrouter"] as ChatProvider[]).find(isReady);
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
    nr.chat?.send({ runId, provider: chatProvider, agent: chatAgentId, model: chatModel || undefined, messages, system: SYSTEM_PROMPT })
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
