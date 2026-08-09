// Sélecteur de moteur compact — déplacé en bas (dans le composer, près de l'envoi). Replie
// moteur (Claude/OpenAI/OpenRouter/CLI) + agent CLI + modèle + mode de permission en menus radio,
// avec un résumé riche (icône + moteur/agent · modèle · mode). Base UI (pas Radix).
import { Bot, Sparkles, Globe, Terminal, ChevronDown, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import type { ChatProvider, ChatPermMode } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

const PROVIDER_LABEL: Record<ChatProvider, string> = { anthropic: "Claude", openai: "OpenAI", openrouter: "OpenRouter", cli: "CLI" };
const MODES: ChatPermMode[] = ["read-only", "ask", "safe", "auto"];
const ANTHROPIC_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const OPENAI_MODELS = ["gpt-5-codex", "o4-mini"];
// Sélection courte de modèles OpenRouter populaires ; n'importe quel id se tape dans le champ libre.
const OPENROUTER_MODELS = [
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-chat-v3",
  "x-ai/grok-4",
  "meta-llama/llama-4-maverick",
];

// Modèle abrégé pour le résumé (claude-opus-4-8 → opus-4-8 ; anthropic/claude-sonnet-4.5 → claude-sonnet-4.5).
const shortModel = (m: string, fallback: string) => {
  const last = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  return last.replace(/^claude-/, "") || fallback;
};

function ProviderIcon({ provider, className }: { provider: ChatProvider; className?: string }) {
  if (provider === "anthropic") return <Bot className={className} />;
  if (provider === "openai") return <Sparkles className={className} />;
  if (provider === "openrouter") return <Globe className={className} />;
  return <Terminal className={className} />;
}

export function EngineMenu() {
  const { t } = useTranslation("chat");
  const provider = useApp((s) => s.chatProvider);
  const setProvider = useApp((s) => s.setChatProvider);
  const agentId = useApp((s) => s.chatAgentId);
  const setAgentId = useApp((s) => s.setChatAgentId);
  const model = useApp((s) => s.chatModel);
  const setModel = useApp((s) => s.setChatModel);
  const mode = useApp((s) => s.chatMode);
  const setMode = useApp((s) => s.setChatMode);
  const agents = useApp((s) => s.chatAgents);

  const cliAgents = (agents?.cli || []).filter((a) => a.available);
  const curAgent = cliAgents.find((a) => a.id === agentId);
  const models = provider === "anthropic" ? ANTHROPIC_MODELS
    : provider === "openai" ? OPENAI_MODELS
    : provider === "openrouter" ? OPENROUTER_MODELS
    : (curAgent?.models || []);

  // Résumé : moteur (nom d'agent pour CLI) · modèle · mode — le modèle est TOUJOURS affiché.
  const head = provider === "cli" ? (curAgent?.name || "CLI") : PROVIDER_LABEL[provider];
  const sub = shortModel(model, t("engine.default"));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground" />}>
        <ProviderIcon provider={provider} className="size-3.5" />
        <span className="text-xs font-medium text-foreground">{head}</span>
        <span className="text-xs opacity-70">· {sub}</span>
        <span className="text-xs opacity-70">· {t(`mode.${mode === "read-only" ? "readonly" : mode}`)}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuRadioGroup value={provider} onValueChange={(v) => setProvider(String(v) as ChatProvider)}>
          <DropdownMenuLabel>{t("engine.engine")}</DropdownMenuLabel>
          <DropdownMenuRadioItem value="anthropic"><Bot className="size-4" /> Claude</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="openai"><Sparkles className="size-4" /> OpenAI</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="openrouter"><Globe className="size-4" /> OpenRouter</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cli"><Terminal className="size-4" /> {t("engine.cliAgent")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        {provider === "cli" && cliAgents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={agentId} onValueChange={(v) => setAgentId(String(v))}>
              <DropdownMenuLabel>{t("engine.agent")}</DropdownMenuLabel>
              {cliAgents.map((a) => <DropdownMenuRadioItem key={a.id} value={a.id}>{a.name}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </>
        )}

        {models.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={model || "default"} onValueChange={(v) => setModel(String(v) === "default" ? "" : String(v))}>
              <DropdownMenuLabel>{t("engine.model")}</DropdownMenuLabel>
              <DropdownMenuRadioItem value="default">{t("engine.default")}</DropdownMenuRadioItem>
              {models.map((m) => <DropdownMenuRadioItem key={m} value={m}>{shortModel(m, t("engine.default"))}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </>
        )}

        {provider === "openrouter" && (
          // Champ libre : n'importe quel id OpenRouter (provider/modele). Stoppe la propagation pour
          // que la saisie clavier ne déclenche pas la navigation typeahead du menu.
          <div className="px-2 pb-1.5 pt-1" onKeyDown={(e) => e.stopPropagation()}>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("engine.freeId")}
              className="h-7 text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(String(v) as ChatPermMode)}>
          <DropdownMenuLabel>{t("engine.permissions")}</DropdownMenuLabel>
          {MODES.map((m) => (
            <Tooltip key={m}>
              <TooltipTrigger render={<DropdownMenuRadioItem value={m}>
                <ShieldCheck className={m === "auto" ? "size-4 text-destructive" : "size-4"} />
                {t(`mode.${m === "read-only" ? "readonly" : m}`)}
              </DropdownMenuRadioItem>} />
              <TooltipContent>{t(`modeTitle.${m === "read-only" ? "readonly" : m}`)}</TooltipContent>
            </Tooltip>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
