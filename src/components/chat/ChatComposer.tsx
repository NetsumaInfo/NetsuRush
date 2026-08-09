// Zone de saisie du Chat IA (flavor Base UI). Textarea auto-grandissante (Entrée = envoyer,
// Maj+Entrée = nouvelle ligne). Barre du bas : sélecteur de moteur compact + pièces jointes à gauche,
// Envoyer / Stop à droite. Les fichiers joints sont passés à l'agent comme chemins locaux (il peut
// les lire / les voir).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Send, Square, Paperclip, X } from "lucide-react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { basename } from "@/lib/utils";
import { EngineMenu } from "./EngineMenu";

export function ChatComposer({ ready }: { ready: boolean }) {
  const { t } = useTranslation(["chat", "common"]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = useApp((s) => s.chatRunning);
  const send = useApp((s) => s.chatSend);
  const cancel = useApp((s) => s.chatCancel);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  const attach = async () => {
    const picked = await nr.chooseFiles();
    if (picked?.length) setFiles((f) => [...new Set([...f, ...picked])]);
  };

  const submit = () => {
    if ((!text.trim() && !files.length) || running) return;
    if (!ready) { setNotice(t("composer.pickEngine")); return; }
    setNotice("");
    const refs = files.length
      ? `\n\n${t("composer.attachedFilesPrompt")}:\n${files.map((f) => `- ${f}`).join("\n")}`
      : "";
    send((text.trim() + refs).trim());
    setText("");
    setFiles([]);
  };

  return (
    <div className="border-t border-border bg-card p-3">
      <div className="flex flex-col rounded-xl border border-border bg-background focus-within:border-ring">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-2 py-1.5">
            {files.map((f) => (
              <span key={f} className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground/80">
                <Paperclip className="size-3 shrink-0 opacity-60" />
                <span className="max-w-40 truncate">{basename(f)}</span>
                <button type="button" onClick={() => setFiles((arr) => arr.filter((x) => x !== f))} aria-label={t("common:action.remove")} className="rounded p-0.5 hover:text-destructive">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="px-3 pt-2.5">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => { setText(e.target.value); if (notice) setNotice(""); }}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            rows={1}
            placeholder={t("composer.placeholder")}
            className="max-h-[200px] w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <EngineMenu />
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("composer.attachFiles")} onClick={attach} />}>
              <Paperclip className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{t("composer.attachTip")}</TooltipContent>
          </Tooltip>

          <div className="ml-auto">
            {running ? (
              <Button size="sm" variant="outline" onClick={cancel}><Square className="size-3.5" /> {t("composer.stop")}</Button>
            ) : (
              <Button size="icon-sm" onClick={submit} disabled={!text.trim() && !files.length} aria-label={t("composer.send")}><Send className="size-4" /></Button>
            )}
          </div>
        </div>
      </div>
      {notice && <div className="mt-1.5 px-1 text-xs text-[var(--color-warn)]">{notice}</div>}
    </div>
  );
}
