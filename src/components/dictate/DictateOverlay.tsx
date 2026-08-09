import { useEffect, useRef, useState } from "react";
import { Mic, Loader2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { useDictation, insertIntoFocused } from "./useDictation";
import { hotkeySatisfied, hotkeyLabel, isModifierCode } from "./dictateHotkey";

// Dictée GLOBALE : PAS de bouton visible. On MAINTIENT le raccourci (défaut Ctrl+Maj) →
// enregistre ; on RELÂCHE → transcrit + insère dans le champ où on était. Seule une pastille discrète
// apparaît PENDANT l'écoute/transcription (rien le reste du temps).
export function DictateOverlay() {
  const { t } = useTranslation("dictate");
  const model = useApp((s) => s.dictateModel);
  const hotkey = useApp((s) => s.dictateHotkey);
  const enabled = useApp((s) => s.dictateEnabled);
  const live = useApp((s) => s.dictateLive);
  const mic = useApp((s) => s.dictateMic);
  const unloadMs = useApp((s) => s.dictateUnloadMs);

  const [partial, setPartial] = useState(""); // texte partiel affiché en direct dans la pastille
  const targetRef = useRef<HTMLElement | null>(null); // champ éditable à réinjecter
  const onText = (t: string) => {
    setPartial("");
    const el = targetRef.current;
    if (el && document.contains(el)) { el.focus(); insertIntoFocused(t); }
    else insertIntoFocused(t);
  };
  const { state, err, start, stop } = useDictation(onText, {
    lang: "fr", model, deviceId: mic || undefined, idleMs: unloadMs,
    onPartial: live ? setPartial : undefined,
  });

  // Refs stables pour l'écouteur clavier (monté une seule fois).
  const activeRef = useRef(false);
  const stateRef = useRef(state);
  const hotkeyRef = useRef(hotkey);
  const startRef = useRef(start);
  const stopRef = useRef(stop);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { hotkeyRef.current = hotkey; }, [hotkey]);
  useEffect(() => { startRef.current = start; }, [start]);
  useEffect(() => { stopRef.current = stop; }, [stop]);

  useEffect(() => {
    if (!enabled) return;
    const pressed = new Set<string>();

    const begin = () => {
      if (activeRef.current) return;
      // Mémorise le champ éditable focalisé (maintenir des modificateurs ne retire pas le focus).
      const el = document.activeElement as HTMLElement | null;
      targetRef.current = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable) ? el : targetRef.current;
      activeRef.current = true;
      setPartial("");
      startRef.current();
    };
    const end = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      stopRef.current();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isModifierCode(e.code)) pressed.add(e.code);
      const sat = hotkeySatisfied(hotkeyRef.current, e, pressed);
      if (sat && !activeRef.current) begin();
      else if (!sat && activeRef.current) end();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      pressed.delete(e.code);
      if (activeRef.current && !hotkeySatisfied(hotkeyRef.current, e, pressed)) end();
    };
    const onBlur = () => { pressed.clear(); if (activeRef.current) end(); };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);

  // L'erreur ne persiste pas : la pastille d'erreur s'efface au bout de 4 s.
  const [errVisible, setErrVisible] = useState(false);
  useEffect(() => {
    if (!err) { setErrVisible(false); return; }
    setErrVisible(true);
    const t = setTimeout(() => setErrVisible(false), 4000);
    return () => clearTimeout(t);
  }, [err]);

  const recording = state === "recording";
  const busy = state === "transcribing";
  const showErr = !!err && errVisible;
  const show = enabled && (recording || busy || showErr);
  if (!show) return null;

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2" data-dictate-pill>
      <div className="flex max-w-[70vw] items-center gap-2 rounded-full border border-border bg-card/95 px-3.5 py-1.5 text-xs shadow-lg backdrop-blur">
        {/* Un avertissement pendant l'écoute (micro de repli) ne doit PAS masquer la pastille : elle
            est la seule preuve que ça enregistre. Il s'affiche à côté, pas à la place. */}
        {showErr && !recording ? (
          <><AlertCircle className="size-3.5 shrink-0 text-destructive" /> <span className="text-destructive">{err}</span></>
        ) : busy ? (
          <><Loader2 className="size-3.5 shrink-0 animate-spin text-primary" /> <span className="text-muted-foreground">{t("transcribing")}</span></>
        ) : (
          <>
            <span className="relative flex size-2.5 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full" style={{ background: "var(--color-ok)", opacity: 0.7 }} />
              <span className="relative inline-flex size-2.5 rounded-full" style={{ background: "var(--color-ok)" }} />
            </span>
            <Mic className="size-3.5 shrink-0 text-foreground" />
            {partial
              ? <span className="truncate text-foreground">{partial}</span>
              : <span className="text-muted-foreground">{t("overlay.listening")} <span className="text-foreground/70">{hotkeyLabel(hotkey)}</span></span>}
            {showErr && <span className="shrink-0 truncate text-destructive">{err}</span>}
          </>
        )}
      </div>
    </div>
  );
}
