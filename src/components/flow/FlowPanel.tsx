import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Square, Send, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { FlowCache } from "@/components/flow/FlowCache";
import { FlowExport } from "@/components/flow/FlowExport";
import { FlowFormat } from "@/components/flow/FlowFormat";
import { FlowInspector } from "@/components/flow/FlowInspector";
import { FlowPreview } from "@/components/flow/FlowPreview";
import { useFlow } from "@/components/flow/useFlow";

/// The engine is a Chromium: it starts when the user asks for it, and the tab
/// says plainly that it is not running rather than starting one on mount.
function EngineGate({ status, busy, onStart }: {
  status: { ready: boolean; prerequisite: string; error: string };
  busy: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation("flow");
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          {status.ready ? t("stopped") : t("notReady")}
        </p>
        {status.prerequisite ? (
          <code className="rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {status.prerequisite}
          </code>
        ) : null}
        {status.error ? <p className="text-xs text-destructive">{status.error}</p> : null}
        <Button onClick={onStart} disabled={busy || !status.ready}>
          {busy ? <Spinner className="size-4" /> : <Play className="size-4" />}
          {busy ? t("starting") : t("start")}
        </Button>
      </div>
    </div>
  );
}

function SourcePane({ value, onApply, busy }: {
  value: string;
  onApply: (html: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation("flow");
  const [draft, setDraft] = useState(value);
  const [known, setKnown] = useState(value);

  // The draft follows the service when the service changes underneath, but not
  // while the user is typing into it — that is what the `known` marker separates.
  if (value !== known) {
    setKnown(value);
    setDraft(value);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Textarea
        className="min-h-0 flex-1 resize-none font-mono text-xs"
        spellCheck={false}
        value={draft}
        placeholder={t("sourcePlaceholder")}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        className="self-start"
        disabled={draft === value}
        onClick={() => onApply(draft)}
      >
        {busy ? t("applying") : t("apply")}
      </Button>
    </div>
  );
}

export function FlowPanel() {
  const { t } = useTranslation("flow");
  const flow = useFlow();
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState("");

  const send = async () => {
    const result = await flow.send();
    if (!result) return;
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  };

  if (!flow.status.running) {
    return (
      <div className="flex h-full flex-col">
        <EngineGate status={flow.status} busy={flow.busy} onStart={() => void flow.start()} />
      </div>
    );
  }

  const state = flow.state;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span className="truncate text-xs text-muted-foreground">
          {flow.error ? "" : flow.applying ? t("applying") : note || t("running")}
        </span>
        <span className="flex-1" />
        {flow.error ? (
          <span className="truncate text-xs text-destructive">{flow.error}</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={
            <Button size="sm" onClick={() => void send()} disabled={flow.busy || !state}>
              {sent ? <Check className="size-4" /> : <Send className="size-4" />}
              {sent ? t("sent") : t("send")}
            </Button>
          } />
          <TooltipContent>{t("sendHint")}</TooltipContent>
        </Tooltip>
        <Button size="sm" variant="ghost" onClick={() => void flow.stop()} disabled={flow.busy}>
          <Square className="size-4" />
          {t("stop")}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[26rem] min-w-0 shrink-0 flex-col border-r">
          <Tabs defaultValue="source" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-3 mt-2">
              <TabsTrigger value="source">{t("tabSource")}</TabsTrigger>
              <TabsTrigger value="params">
                {t("tabParams")}
                {state?.variables.length ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {state.variables.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="cache">{t("tabCache")}</TabsTrigger>
              <TabsTrigger value="export">{t("tabExport")}</TabsTrigger>
            </TabsList>

            <TabsContent value="source" className="flex min-h-0 flex-1 flex-col">
              <SourcePane
                value={state?.html ?? ""}
                busy={flow.busy}
                onApply={(html) => void flow.save({ html })}
              />
            </TabsContent>

            <TabsContent value="params" className="min-h-0 flex-1 overflow-y-auto">
              {state ? (
                <>
                  <FlowFormat
                    state={state}
                    onApply={(width, height) => void flow.save({ width, height })}
                  />
                  <div className="border-t">
                    <FlowInspector
                      variables={state.variables}
                      overrides={flow.overrides}
                      onChange={flow.setVariable}
                    />
                  </div>
                </>
              ) : null}
            </TabsContent>

            <TabsContent value="cache" className="min-h-0 flex-1 overflow-y-auto">
              <FlowCache running={flow.status.running} />
            </TabsContent>

            <TabsContent value="export" className="min-h-0 flex-1 overflow-y-auto">
              <FlowExport
                running={flow.status.running}
                durationFrames={state?.durationFrames ?? 0}
              />
            </TabsContent>
          </Tabs>
        </div>

        {state && state.html ? (
          <FlowPreview
            state={state}
            frame={flow.frame}
            onFrame={flow.setFrame}
            frameUrl={flow.frameUrl}
            revision={flow.revision}
            editorPort={flow.status.editorPort}
            note={setNote}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-8">
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
