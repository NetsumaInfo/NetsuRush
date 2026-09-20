// Onglet « Chat IA » : copilote agentique qui pilote DaVinci Resolve et les modules NetsuRush via des
// outils. Branche les flux SSE (événements + approbations) au store, charge les agents disponibles,
// et assemble en-tête / réglages / fil / barre d'approbation / composer.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { BetaNotice } from "@/components/common/BetaNotice";
import { ChatHeader } from "./ChatHeader";
import { ChatSettings } from "./ChatSettings";
import { ChatComposer } from "./ChatComposer";
import { ApprovalBar } from "./ApprovalBar";
import { Message } from "./Message";
import { buildEngines, toEngineId } from "@/lib/agentCatalog";

export function ChatPanel() {
  const { t } = useTranslation("chat");
  const [showSettings, setShowSettings] = useState(false);
  const messages = useApp((s) => s.chatMessages);
  const running = useApp((s) => s.chatRunning);
  const provider = useApp((s) => s.chatProvider);
  const agentId = useApp((s) => s.chatAgentId);
  const agents = useApp((s) => s.chatAgents);
  const ingest = useApp((s) => s.chatIngest);
  const setApproval = useApp((s) => s.chatSetApproval);
  const loadAgents = useApp((s) => s.chatLoadAgents);
  const error = useApp((s) => s.chatError);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadAgents();
    const offEv = nr.chat?.onEvent(ingest);
    const offAp = nr.chat?.onApproval(setApproval);
    return () => { offEv?.(); offAp?.(); };
  }, [ingest, setApproval, loadAgents]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // « Prêt » se lit sur le moteur choisi, plus sur une chaîne de ternaires par
  // fournisseur : celle-ci avait oublié xAI, qui retombait donc sur `true` et
  // laissait envoyer sans clé — pour un appel réseau voué à l'échec.
  const engine = buildEngines(agents).find((e) => e.id === toEngineId(provider, agentId));
  const ready = engine?.ready ?? false;

  return (
    <div className="flex h-full flex-col">
      <ChatHeader onSettings={() => setShowSettings((s) => !s)} />
      {showSettings ? (
        <ChatSettings onClose={() => setShowSettings(false)} />
      ) : (
        <>
      <BetaNotice module="chat" className="mx-4 mt-4" />

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary"><Bot className="size-5" /></div>
            <div className="text-sm font-semibold">{t("panel.copilot")}</div>
            {!ready && (
              <button type="button" onClick={() => setShowSettings(true)} className="text-xs text-primary underline-offset-2 hover:underline">
                {provider === "cli" ? t("panel.noCliAgent") : t("panel.configureKey")}
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-4">
            {messages.map((m, i) => <Message key={m.id} msg={m} active={running && i === messages.length - 1 && m.role === "assistant"} />)}
            {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
          </div>
        )}
      </div>
        </>
      )}

      <ApprovalBar />
      <ChatComposer ready={ready} />
    </div>
  );
}
