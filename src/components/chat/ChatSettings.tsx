// Réglages du Chat IA : clés API BYOK (Anthropic / OpenAI / OpenRouter) + agents CLI détectés.
// Saisies → chiffrées au repos via Stronghold (keystore) PUIS poussées au core (en RAM). Au montage,
// charge les clés existantes et les ré-applique.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Sparkles, Globe, Terminal, KeyRound, Check, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { loadKeys, saveKey, keystoreAvailable, type KeyName } from "@/lib/keystore";

const PROVIDERS: { id: KeyName; label: string; placeholder: string; icon: typeof Bot }[] = [
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…", icon: Bot },
  { id: "openai", label: "OpenAI", placeholder: "sk-…", icon: Sparkles },
  { id: "openrouter", label: "OpenRouter", placeholder: "sk-or-…", icon: Globe },
];

export function ChatSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["chat", "common"]);
  const configureKeys = useApp((s) => s.chatConfigureKeys);
  const keysSet = useApp((s) => s.chatKeysSet);
  const agents = useApp((s) => s.chatAgents);
  const loadAgents = useApp((s) => s.chatLoadAgents);
  const cli = agents?.cli || [];
  const [values, setValues] = useState<Record<KeyName, string>>({ anthropic: "", openai: "", openrouter: "" });
  const [shown, setShown] = useState<Record<KeyName, boolean>>({ anthropic: false, openai: false, openrouter: false });
  const [saved, setSaved] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Recharge les clés persistées et les ré-applique au core au 1er affichage.
  useEffect(() => {
    void (async () => {
      const k = await loadKeys();
      if (k.anthropic || k.openai || k.openrouter) {
        await configureKeys({ anthropicKey: k.anthropic, openaiKey: k.openai, openrouterKey: k.openrouter });
      }
    })();
  }, [configureKeys]);

  const save = async () => {
    for (const p of PROVIDERS) if (values[p.id]) await saveKey(p.id, values[p.id]);
    await configureKeys({
      ...(values.anthropic ? { anthropicKey: values.anthropic } : {}),
      ...(values.openai ? { openaiKey: values.openai } : {}),
      ...(values.openrouter ? { openrouterKey: values.openrouter } : {}),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const rescan = async () => {
    setScanning(true);
    try { await loadAgents(); } finally { setScanning(false); }
  };

  return (
    <div className="border-b border-border bg-card p-3">
      {/* ---- Clés API ---- */}
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-muted-foreground" /> {t("settings.apiKeys")}
      </div>
      {!keystoreAvailable && (
        <div className="mb-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {t("settings.noVault")}
        </div>
      )}
      <div className="grid gap-1.5">
        {PROVIDERS.map(({ id, label, placeholder, icon: Icon }) => (
          <div key={id} className="flex items-center gap-2">
            <div className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="size-3.5" /> {label}
            </div>
            <div className="relative flex-1">
              <Input
                type={shown[id] ? "text" : "password"}
                value={values[id]}
                onChange={(e) => setValues((v) => ({ ...v, [id]: e.target.value }))}
                placeholder={placeholder}
                autoComplete="off"
                className="h-8 pr-8 text-xs"
              />
              <Tooltip>
                <TooltipTrigger render={
                  <button
                    type="button"
                    onClick={() => setShown((s) => ({ ...s, [id]: !s[id] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={shown[id] ? t("settings.hide") : t("settings.show")}
                  >
                    {shown[id] ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                } />
                <TooltipContent>{shown[id] ? t("settings.hide") : t("settings.show")}</TooltipContent>
              </Tooltip>
            </div>
            {keysSet[id]
              ? <Badge variant="outline" className="shrink-0 border-[var(--color-ok)]/40 text-[var(--color-ok)]">{t("settings.keySet")}</Badge>
              : <Badge variant="outline" className="shrink-0 text-muted-foreground">{t("settings.keyAbsent")}</Badge>}
          </div>
        ))}
      </div>

      <Separator className="my-3" />

      {/* ---- Agents CLI ---- */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="size-4 text-muted-foreground" /> {t("settings.cliAgents")}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void rescan()} disabled={scanning}>
          <RefreshCw className={scanning ? "size-3.5 animate-spin" : "size-3.5"} /> {t("settings.rescan")}
        </Button>
      </div>
      <div className="grid gap-1">
        {cli.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            {t("settings.noAgentsPre")}<code>claude</code>/<code>codex</code>{t("settings.noAgentsPost")}
          </div>
        ) : cli.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded-md px-1 py-0.5 text-xs">
            <span className={a.available ? "text-foreground" : "text-muted-foreground"}>{a.name}</span>
            {a.available
              ? <Badge variant="outline" className="border-[var(--color-ok)]/40 text-[var(--color-ok)]">{t("settings.detected")}{a.version ? ` · ${a.version}` : ""}</Badge>
              : <Badge variant="outline" className="text-muted-foreground">{t("settings.absent")}</Badge>}
          </div>
        ))}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>{t("common:action.close")}</Button>
        <Button size="sm" onClick={save}>{saved ? <><Check className="size-3.5" /> {t("settings.saved")}</> : t("common:action.save")}</Button>
      </div>
    </div>
  );
}
