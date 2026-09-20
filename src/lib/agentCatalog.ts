// The provider catalogue, in one place both surfaces read.
//
// It used to live scattered across the engine menu and the settings panel, so
// a model list could be current in one and a generation behind in the other —
// which is exactly what had happened. One table, two readers.

import type { ChatAgentsInfo, ChatProvider } from "@/lib/bridge";
import type { KeyName } from "@/lib/keystore";

export type ByokProvider = {
  id: KeyName;
  provider: ChatProvider;
  label: string;
  placeholder: string;
  /** Where to get a key. Shown as a link, because "get a key" is the first step. */
  keyUrl: string;
  /** Editable when the endpoint is not fixed — a local model, a proxy, a region. */
  baseUrl?: { default: string; hint: string };
  /**
   * Offline fallback ONLY. The live list comes from `nr.chat.models()`, which
   * asks the vendor. These were the sole source once, and they had silently
   * gone a generation stale — which is what a hand-typed model list always
   * does. Kept short so nobody mistakes them for current.
   */
  models: string[];
};

/// Only providers that are wired end to end. A catalogue entry with no adapter
/// behind it is a promise the settings panel cannot keep.
export const BYOK_PROVIDERS: ByokProvider[] = [
  {
    id: "anthropic",
    provider: "anthropic",
    label: "Anthropic",
    placeholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    provider: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    // The override is what makes every OpenAI-compatible endpoint reachable
    // without an adapter: Ollama, LM Studio, a local routing proxy, Azure.
    baseUrl: {
      default: "https://api.openai.com/v1",
      hint: "Ollama, LM Studio, proxy local…",
    },
    models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  {
    id: "openrouter",
    provider: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
    models: [
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5",
      "openai/gpt-6-astra",
      "google/gemini-3.8-flash",
      "x-ai/grok-4.6",
      "moonshotai/kimi-k3",
    ],
  },
  {
    id: "xai",
    provider: "xai",
    label: "Grok (xAI)",
    placeholder: "xai-…",
    keyUrl: "https://console.x.ai",
    // EU accounts are served from their own host; the US one is the default.
    baseUrl: {
      default: "https://api.x.ai/v1",
      hint: "UE : https://eu-west-1.api.x.ai/v1",
    },
    models: ["grok-4.6", "grok-4.5", "grok-4.3"],
  },
];

/// Where a CLI agent comes from, so "absent" can say what to install rather
/// than only that something is missing.
///
/// `docs` is always present and is the page the vendor documents; it is the
/// only route offered for agents with no `install` command, and the fallback
/// for a machine that cannot run one — a missing Node, a locked-down shell —
/// so the row is never a dead end.
export type CliSource = {
  bin: string;
  /**
   * A command NetsuRush may run for you. Absent when the vendor only ships a
   * remote install script: those are refused by the core, Defender blocks the
   * `irm … | iex` shape on sight, and one of the two URLs we carried served a
   * 162 KB HTML page rather than a script. Such an agent shows `docs` instead,
   * and the person installs it themselves.
   */
  install?: string;
  docs: string;
  installKind: "npm" | "pip" | "script";
};

export const CLI_SOURCES: Record<string, CliSource> = {
  claude: {
    bin: "claude", installKind: "npm",
    install: "npm install -g @anthropic-ai/claude-code",
    docs: "https://docs.claude.com/en/docs/claude-code/overview",
  },
  codex: {
    bin: "codex", installKind: "npm",
    install: "npm install -g @openai/codex",
    docs: "https://developers.openai.com/codex/cli",
  },
  copilot: {
    bin: "copilot", installKind: "npm",
    install: "npm install -g @github/copilot",
    docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
  },
  grok: {
    bin: "grok", installKind: "npm",
    install: "npm install -g @xai-official/grok",
    docs: "https://docs.x.ai/build/cli",
  },
  antigravity: {
    // A compiled binary behind a one-line script; there is no package to add,
    // so there is nothing here we are willing to run on someone's behalf.
    bin: "agy", installKind: "script",
    docs: "https://antigravity.google/docs/cli/install/",
  },
  gemini: {
    bin: "gemini", installKind: "npm",
    install: "npm install -g @google/gemini-cli",
    docs: "https://github.com/google-gemini/gemini-cli",
  },
  opencode: {
    bin: "opencode", installKind: "npm",
    install: "npm install -g opencode-ai",
    docs: "https://opencode.ai/docs",
  },
  qwen: {
    bin: "qwen", installKind: "npm",
    install: "npm install -g @qwen-code/qwen-code",
    docs: "https://github.com/QwenLM/qwen-code",
  },
  cursor: {
    bin: "cursor-agent", installKind: "script",
    docs: "https://cursor.com/docs/cli",
  },
  aider: {
    bin: "aider", installKind: "pip",
    install: "python -m pip install aider-install",
    docs: "https://aider.chat/docs/install.html",
  },
};

export const byokProvider = (id: string) => BYOK_PROVIDERS.find((p) => p.id === id) ?? null;

// ---- Engines -------------------------------------------------------------
//
// One flat list of things you can actually run: Claude Code, Codex, Copilot,
// an Anthropic key, an OpenRouter key. That is the question a user has — "what
// am I about to use?" — and it now takes one choice to answer.
//
// It used to take two, because the wire protocol's shape leaked into the menu:
// a CLI run is `provider:"cli"` plus an agent id, so the menu asked for a
// provider and then, for that one value, asked again. "CLI agent" is a fact
// about how NetsuRush spawns a process, not a thing anybody wants to pick.
//
// The protocol is unchanged — `toWire` puts the two fields back together.

export type Engine = {
  /** Stable id for the radio group: `cli:claude`, `api:anthropic`. */
  id: string;
  kind: "cli" | "api";
  label: string;
  /** Second line: the binary, or where the key goes. */
  hint?: string;
  /** Whose model catalogue applies — never the engine id, they differ often. */
  modelsFrom: string;
  /**
   * What to show when the live list is not there: an older core with no
   * `chat:models`, or no network. An empty model dropdown reads as "this engine
   * has no models", which is never true and leaves no way forward.
   */
  fallbackModels: string[];
  /** Runnable right now: the binary was found, or the key is set. */
  ready: boolean;
  /**
   * Accepts a reasoning-effort setting. Read out of each binary's own `--help`
   * rather than assumed: Claude Code, Copilot and Antigravity all expose
   * `--effort`, which an earlier guess here had missed. Gemini CLI documents
   * no such flag, so it gets no control — one that quietly does nothing is
   * worse than none at all.
   */
  thinking: boolean;
};

/// Verifie fournisseur par fournisseur, binaire par binaire.
const THINKING_PROVIDERS = ["anthropic", "openai", "openrouter", "xai"];
const THINKING_CLI = ["claude", "codex", "copilot", "antigravity"];

/// Renderer-side last resort, per provider. Google has no BYOK entry (there is
/// no Gemini adapter), yet two agents serve its models, so it needs one here.
const FALLBACK_MODELS: Record<string, string[]> = {
  google: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3-pro"],
};

const fallbackFor = (modelsFrom: string) =>
  BYOK_PROVIDERS.find((p) => p.id === modelsFrom)?.models ?? FALLBACK_MODELS[modelsFrom] ?? [];

/** Splits an engine id back into the two fields `chat:send` expects. */
export function toWire(engineId: string): { provider: ChatProvider; agent?: string } {
  const [kind, rest] = engineId.split(":");
  if (kind === "cli" && rest) return { provider: "cli", agent: rest };
  return { provider: (rest || "anthropic") as ChatProvider };
}

/** Rebuilds the engine id from a stored provider/agent pair. */
export const toEngineId = (provider: ChatProvider, agent?: string) =>
  provider === "cli" ? `cli:${agent || "claude"}` : `api:${provider}`;

/**
 * Every engine, agents first.
 *
 * Agents come first because a CLI you already subscribe to costs nothing extra,
 * and only unavailable ones are dropped: an agent that is not installed is a
 * settings problem, and a picker that offers what cannot run is a trap.
 */
export function buildEngines(info: ChatAgentsInfo | null): Engine[] {
  const cli = (info?.cli ?? [])
    .filter((agent) => agent.available)
    .map((agent): Engine => {
      // An agent without a declared catalogue still has to ask someone, and
      // OpenRouter is the only source that covers every vendor at once.
      const modelsFrom = agent.modelsFrom || "openrouter";
      return {
        id: `cli:${agent.id}`,
        kind: "cli",
        label: agent.name,
        hint: CLI_SOURCES[agent.id]?.bin ?? agent.bin,
        modelsFrom,
        // What the running core reported wins: it knows which agent this is.
        // The provider table stands in when that core predates the field.
        fallbackModels: agent.models?.length ? agent.models : fallbackFor(modelsFrom),
        ready: true,
        thinking: THINKING_CLI.includes(agent.id),
      };
    });

  const api = BYOK_PROVIDERS.map((provider): Engine => ({
    id: `api:${provider.provider}`,
    kind: "api",
    label: provider.label,
    modelsFrom: provider.id,
    fallbackModels: provider.models,
    ready: !!info?.byok[provider.id as keyof typeof info.byok],
    thinking: THINKING_PROVIDERS.includes(provider.id),
  }));

  return [...cli, ...api];
}
