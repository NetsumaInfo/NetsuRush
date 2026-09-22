// Connections for the AI engine: the CLI agents found on this machine, then the
// BYOK keys.
//
// Agents first, keys second, because a subscription CLI is the path that costs
// nothing extra and most people already have one — asking for an API key before
// mentioning it puts the expensive option in front.
//
// Both are drawers: eleven providers and agents expanded at once is a wall, and
// a closed drawer still says how many of its entries are ready, so folding one
// away loses nothing.
//
// Every key can be tested against the real API before it is saved. The panel
// this replaced reported "key set", which only ever meant the field was not
// empty — it said nothing about whether the key was accepted, whether the
// account had credit, or whether the endpoint answered, all of which fail later
// as an error nobody can connect back to what they typed.
//
// Keys are encrypted at rest through Stronghold and pushed to the core in RAM;
// the core never reads the vault.
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, Clapperboard, Download, Eye, EyeOff, ExternalLink, KeyRound, LogIn, RefreshCw, ShieldAlert, Terminal, X } from "lucide-react";

import { useApp } from "@/store";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { nr } from "@/lib/bridge";
import type { ChatAgentInfo, ChatResolveMcp } from "@/lib/bridge";
import { BYOK_PROVIDERS, CLI_SOURCES } from "@/lib/agentCatalog";
import { loadKeys, saveKey, keystoreAvailable, type KeyName } from "@/lib/keystore";

type Probe = { state: "idle" | "running" | "done"; ok?: boolean; detail?: string; ms?: number };

const emptyByKey = <T,>(value: T) =>
  Object.fromEntries(BYOK_PROVIDERS.map((p) => [p.id, value])) as Record<KeyName, T>;

function AgentRow({ agent, onRescan }: { agent: ChatAgentInfo; onRescan: () => void }) {
  const { t } = useTranslation("chat");
  const source = CLI_SOURCES[agent.id];
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  const run = async (work: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true);
    setSaid("");
    try {
      const result = await work();
      // The work happens in the terminal that just opened, so the panel says
      // where to look rather than pretending to know how it went.
      setSaid(result.ok ? done : (result.error ?? ""));
    } finally {
      setBusy(false);
    }
  };

  const connect = () => run(
    () => nr.chat!.login({ id: agent.id, bin: agent.bin }),
    t("settings.loginOpened"),
  );

  // Absent quand l'editeur ne publie qu'un script distant : la page officielle
  // est alors le seul chemin propose (cf. CliSource.install).
  const install = source.install
    ? () => run(() => nr.chat!.install({ command: source.install! }), t("settings.installOpened"))
    : null;

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2 text-xs">
        <span className={agent.available ? "text-foreground" : "text-muted-foreground"}>{agent.name}</span>
        {source ? <code className="text-[10px] text-muted-foreground">{source.bin}</code> : null}
        <span className="flex-1" />

        {agent.available ? (
          <>
            <Badge variant="outline" className="border-[var(--color-ok)]/40 text-[var(--color-ok)]">
              {t("settings.detected")}{agent.version ? ` · ${agent.version}` : ""}
            </Badge>
            <Tooltip>
              <TooltipTrigger render={
                <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => void connect()} disabled={busy}>
                  {busy ? <Spinner className="size-3" /> : <LogIn className="size-3" />}
                </Button>
              } />
              <TooltipContent>{t("settings.connect")}</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <>
            {agent.state === "app-without-cli" ? (
              // The application is installed and its command is not. Two
              // different problems: saying only "absent" sends the user looking
              // for an app they already have.
              <Tooltip>
                <TooltipTrigger render={
                  <Badge variant="outline" className="cursor-default border-amber-500/40 text-amber-500">
                    {t("settings.appNoCli")}
                  </Badge>
                } />
                <TooltipContent>{t("settings.appNoCliHint", { bin: source?.bin ?? agent.bin })}</TooltipContent>
              </Tooltip>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">{t("settings.absent")}</Badge>
            )}
            {source ? (
              <>
                {/* Un paquet npm ou pip se lance ici : il est nomme et resolu
                    par un gestionnaire de paquets. Un script distant, non —
                    d'ou l'absence de bouton et le renvoi vers la page. */}
                {install ? (
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => void install()} disabled={busy}>
                        {busy ? <Spinner className="size-3" /> : <Download className="size-3" />}
                      </Button>
                    } />
                    <TooltipContent>{source.install}</TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => void nr.openExternal(source.docs)}
                      aria-label={t("settings.docs")}
                    >
                      <ExternalLink className="size-3" />
                    </button>
                  } />
                  <TooltipContent>{install ? t("settings.docs") : t("settings.installPage")}</TooltipContent>
                </Tooltip>
              </>
            ) : null}
          </>
        )}
      </div>
      {said ? (
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {said}
          {/* An install only shows up here once the detector runs again, and
              the terminal finishes on its own schedule. */}
          <button type="button" className="underline hover:text-foreground" onClick={onRescan}>
            {t("settings.rescan")}
          </button>
        </p>
      ) : null}
    </div>
  );
}

function ProviderRow({ provider, keySet, value, onValue, baseUrl, onBaseUrl }: {
  provider: (typeof BYOK_PROVIDERS)[number];
  keySet: boolean;
  value: string;
  onValue: (next: string) => void;
  baseUrl: string;
  onBaseUrl: (next: string) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [shown, setShown] = useState(false);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });

  const test = async () => {
    if (!nr.chat) return;
    setProbe({ state: "running" });
    // The typed key wins over the stored one, so a key can be tried before it
    // is committed to the vault.
    const result = await nr.chat.probe({
      provider: provider.provider,
      key: value || undefined,
      baseUrl: baseUrl || undefined,
      model: provider.models[0],
    });
    setProbe({ state: "done", ok: result.ok, detail: result.detail, ms: result.ms });
  };

  return (
    <div className="rounded-md border p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-xs font-medium">{provider.label}</span>
        <Badge
          variant="outline"
          className={keySet
            ? "border-[var(--color-ok)]/40 text-[10px] text-[var(--color-ok)]"
            : "text-[10px] text-muted-foreground"}
        >
          {keySet ? t("settings.keySet") : t("settings.keyAbsent")}
        </Badge>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void nr.openExternal(provider.keyUrl)}
              aria-label={t("settings.getKey")}
            >
              <ExternalLink className="size-3.5" />
            </button>
          } />
          <TooltipContent>{t("settings.getKey")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={shown ? "text" : "password"}
            value={value}
            onChange={(e) => onValue(e.target.value)}
            placeholder={provider.placeholder}
            autoComplete="off"
            className="h-8 pr-8 text-xs"
          />
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={shown ? t("settings.hide") : t("settings.show")}
          >
            {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 shrink-0"
          onClick={() => void test()}
          disabled={probe.state === "running" || (!value && !keySet)}
        >
          {probe.state === "running" ? <Spinner className="size-3.5" /> : null}
          {t("settings.test")}
        </Button>
      </div>

      {provider.baseUrl ? (
        <Input
          className="mt-1.5 h-7 font-mono text-[11px]"
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          placeholder={`${provider.baseUrl.default}  —  ${t(`settings.baseUrlHint.${provider.id}`, { defaultValue: provider.baseUrl.hint })}`}
          spellCheck={false}
        />
      ) : null}

      {probe.state === "done" ? (
        <p className={`mt-1.5 flex items-center gap-1 text-[11px] ${probe.ok ? "text-[var(--color-ok)]" : "text-destructive"}`}>
          {probe.ok ? <Check className="size-3" /> : <X className="size-3" />}
          {probe.ok ? t("settings.reachable", { ms: probe.ms }) : probe.detail}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Blackmagic's own MCP server, shipped inside Resolve Studio 21.1+.
 *
 * Nothing to install and nothing to configure: it is found or it is not, which
 * is why this drawer reports rather than asks. The one control it carries is
 * the sandbox escape, and it sits behind the report on purpose — its risk only
 * makes sense once you know which server is answering.
 */
function ResolveMcpSection({ info }: { info: ChatResolveMcp | null | undefined }) {
  const { t } = useTranslation("chat");
  const unsafe = useApp((s) => s.chatResolveUnsafe);
  const setUnsafe = useApp((s) => s.setChatResolveUnsafe);

  // Three states, three different things to do about them, so they do not
  // collapse into one grey "unavailable": no Resolve Studio, a server that is
  // there but did not answer, and a working one.
  if (!info || !info.installed) {
    return (
      <div className="grid gap-1.5 text-xs text-muted-foreground">
        <span>{t("settings.resolveMcpMissing")}</span>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={info.available ? "text-foreground" : "text-muted-foreground"}>
          {t("settings.resolveMcpServer")}
        </span>
        <span className="flex-1" />
        {info.available ? (
          <Badge variant="outline" className="border-[var(--color-ok)]/40 text-[var(--color-ok)]">
            {t("settings.detected")}{info.version ? ` · ${info.version}` : ""}
          </Badge>
        ) : (
          <Tooltip>
            <TooltipTrigger render={
              <Badge variant="outline" className="cursor-default border-amber-500/40 text-amber-500">
                {t("settings.resolveMcpSilent")}
              </Badge>
            } />
            <TooltipContent>{info.error || t("settings.resolveMcpSilentHint")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("settings.resolveMcpHint", { n: info.tools.length })}
      </p>

      {/* Not a permission level: once the script runs, no mode of ours can hold
          it back. Hence a separate decision, unchecked, with what it opens
          spelled out in the row rather than hidden behind a hover. */}
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2 py-1.5">
        <Checkbox
          className="mt-0.5"
          checked={unsafe}
          disabled={!info.available}
          onCheckedChange={(next) => void setUnsafe(Boolean(next))}
        />
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1 text-xs font-medium">
            <ShieldAlert className="size-3 text-amber-500" />
            {t("settings.resolveUnsafe")}
          </span>
          <span className="text-[11px] leading-snug text-muted-foreground">{t("settings.resolveUnsafeHint")}</span>
        </span>
      </label>
    </div>
  );
}

export function ChatSettings({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["chat", "common"]);
  const configureKeys = useApp((s) => s.chatConfigureKeys);
  const keysSet = useApp((s) => s.chatKeysSet);
  const agents = useApp((s) => s.chatAgents);
  const loadAgents = useApp((s) => s.chatLoadAgents);
  const cli = agents?.cli || [];
  const resolveMcp = agents?.resolveMcp;

  const [values, setValues] = useState<Record<KeyName, string>>(() => emptyByKey(""));
  const [baseUrls, setBaseUrls] = useState<Record<KeyName, string>>(() => emptyByKey(""));
  const [saved, setSaved] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Reloads the persisted keys and re-applies them to the core on first show.
  useEffect(() => {
    void (async () => {
      const stored = await loadKeys();
      if (Object.values(stored).some(Boolean)) {
        await configureKeys({
          anthropicKey: stored.anthropic,
          openaiKey: stored.openai,
          openrouterKey: stored.openrouter,
          xaiKey: stored.xai,
        });
      }
    })();
  }, [configureKeys]);

  const save = async () => {
    for (const provider of BYOK_PROVIDERS) {
      if (values[provider.id]) await saveKey(provider.id, values[provider.id]);
    }
    await configureKeys({
      ...(values.anthropic ? { anthropicKey: values.anthropic } : {}),
      ...(values.openai ? { openaiKey: values.openai } : {}),
      ...(values.openrouter ? { openrouterKey: values.openrouter } : {}),
      ...(values.xai ? { xaiKey: values.xai } : {}),
      ...(baseUrls.openai ? { openaiBaseUrl: baseUrls.openai } : {}),
      ...(baseUrls.xai ? { xaiBaseUrl: baseUrls.xai } : {}),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const rescan = async () => {
    setScanning(true);
    try { await loadAgents(); } finally { setScanning(false); }
  };

  // Scan a l'ouverture. Le bouton reste, pour le cas ou l'on vient d'installer
  // un agent sans fermer le panneau — mais devoir l'actionner pour voir la
  // liste du tout etait la panne, pas le confort.
  useEffect(() => { void rescan(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const ready = cli.filter((a) => a.available).length;
  const keysReady = BYOK_PROVIDERS.filter((p) => keysSet[p.id]).length;

  return (
    // Le tiroir OCCUPE la zone du panneau au lieu de s'y superposer avec sa
    // propre hauteur maximale : empile, il ouvrait une seconde barre de
    // defilement dans un panneau qui defilait deja, et reduisait le fil a une
    // bande. `min-h-0` est ce qui autorise un enfant flex a retrecir.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-b border-border bg-card px-3 pb-3">
      <Accordion defaultValue={["agents"]} className="w-full">
        <AccordionItem value="agents" className="border-b border-border">
          <AccordionTrigger className="h-10 gap-3 text-xs font-semibold hover:no-underline">
            <Terminal className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0">{t("settings.cliAgents")}</span>
            {/* A closed drawer still reports its state, so folding it away
                costs nothing. */}
            <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">
              {t("settings.readyCount", { ready, total: cli.length })}
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-2">
            <div className="mb-1 flex justify-end">
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => void rescan()} disabled={scanning}>
                <RefreshCw className={scanning ? "size-3 animate-spin" : "size-3"} /> {t("settings.rescan")}
              </Button>
            </div>
            {cli.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                <Trans t={t} i18nKey="settings.noAgents" components={[<code key="claude" />, <code key="codex" />]} />
              </div>
            ) : cli.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onRescan={() => void rescan()} />
            ))}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="resolve-mcp" className="border-b border-border">
          <AccordionTrigger className="h-10 gap-3 text-xs font-semibold hover:no-underline">
            <Clapperboard className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0">{t("settings.resolveMcp")}</span>
            <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">
              {resolveMcp?.available
                ? t("settings.resolveMcpTools", { n: resolveMcp.tools.length })
                : t("settings.absent")}
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-2">
            <ResolveMcpSection info={resolveMcp} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="keys" className="border-b-0">
          <AccordionTrigger className="h-10 gap-3 text-xs font-semibold hover:no-underline">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0">{t("settings.apiKeys")}</span>
            <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground">
              {t("settings.readyCount", { ready: keysReady, total: BYOK_PROVIDERS.length })}
            </span>
          </AccordionTrigger>
          <AccordionContent className="pb-2">
            {!keystoreAvailable && (
              <div className="mb-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                {t("settings.noVault")}
              </div>
            )}
            <div className="grid gap-2">
              {BYOK_PROVIDERS.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  keySet={keysSet[provider.id] ?? false}
                  value={values[provider.id]}
                  onValue={(next) => setValues((v) => ({ ...v, [provider.id]: next }))}
                  baseUrl={baseUrls[provider.id]}
                  onBaseUrl={(next) => setBaseUrls((v) => ({ ...v, [provider.id]: next }))}
                />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>{t("common:action.close")}</Button>
        <Button size="sm" onClick={save}>
          {saved ? <><Check className="size-3.5" /> {t("settings.saved")}</> : t("common:action.save")}
        </Button>
      </div>
    </div>
  );
}
