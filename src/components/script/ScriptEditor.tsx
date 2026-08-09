// Éditeur Script — shell « focus écriture » : l'éditeur Tiptap est plein cadre, les panneaux
// (Footages à gauche, Plan/Tags/Todos à droite) sont FERMÉS par défaut et pilotés par le store
// (ouverture à la demande OU contextuelle — /transcript ouvre Footages en mode Paroles). Le volet
// SPLIT (droite du script) monte le Carnet complet — écrire ses notes sans quitter NetsuDraft.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { NotebookPanel } from "@/components/notebook/NotebookPanel";
import { useScript } from "./useScript";
import { useScriptAutosave } from "./useScriptAutosave";
import { useScriptPersistence } from "./useScriptPersistence";
import { useScriptPrefs } from "./scriptPrefs";
import { ScriptTopBar } from "./ScriptTopBar";
import { FootagesPanel } from "./FootagesPanel";
import { RightPanel } from "./RightPanel";
import { NotebookEditor } from "./NotebookEditor";
import { type ScriptView } from "./scriptShared";
import "./scriptShell.css";
import "./notebookProse.css";

const FOOTAGES_WIDTH_KEY = "nr-script-footages-width";
const readFootagesWidth = () => {
  const value = Number(localStorage.getItem(FOOTAGES_WIDTH_KEY));
  return Number.isFinite(value) && value >= 220 && value <= 440 ? value : 280;
};

interface Props {
  persistence: ReturnType<typeof useScriptPersistence>;
}

export function ScriptEditor({ persistence }: Props) {
  const { t } = useTranslation("script");
  const { save, notice } = persistence;
  const doc = useScript((s) => s.doc);
  const footagesOpen = useScript((s) => s.footagesOpen);
  const rightOpen = useScript((s) => s.rightOpen);
  const splitOpen = useScript((s) => s.splitOpen);
  const splitRatio = useScriptPrefs((s) => s.prefs.splitRatio);
  const [view, setView] = usePersistedChoice<ScriptView>("nr.script.view", ["all", "no-audio", "text-only"], "all");
  const shellRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [footagesWidth, setFootagesWidth] = useState(readFootagesWidth);
  const [footagesDragging, setFootagesDragging] = useState(false);

  useScriptAutosave(save);

  // Poignée du split : glisser ajuste la largeur du volet Carnet (ratio persisté dans les prefs).
  const onDividerDown = useCallback((ev: React.PointerEvent) => {
    ev.preventDefault();
    setDragging(true);
    const move = (e: PointerEvent) => {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      const ratio = Math.min(0.7, Math.max(0.2, (rect.right - e.clientX) / rect.width));
      useScriptPrefs.getState().setPrefs({ splitRatio: ratio });
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const onFootagesDividerDown = useCallback((ev: React.PointerEvent) => {
    ev.preventDefault();
    setFootagesDragging(true);
    const move = (event: PointerEvent) => {
      const rect = shellRef.current?.getBoundingClientRect();
      if (!rect) return;
      setFootagesWidth(Math.round(Math.min(440, Math.max(220, event.clientX - rect.left))));
    };
    const up = () => {
      setFootagesDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(FOOTAGES_WIDTH_KEY, String(footagesWidth)); } catch { /* noop */ }
  }, [footagesWidth]);

  // Raccourcis panneaux : Ctrl+[ Footages · Ctrl+] panneau droit.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "[") { e.preventDefault(); useScript.getState().toggleFootages(); }
      else if (k === "]") { e.preventDefault(); useScript.getState().toggleRight(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onHome = useCallback(async () => {
    await save();
    useScript.getState().closeDoc();
  }, [save]);

  if (!doc) return null;

  return (
    <div className={`nr-script view-${view}`} ref={shellRef}>
      <FootagesPanel collapsed={!footagesOpen} width={footagesWidth} onHome={() => void onHome()} />
      {footagesOpen && (
        <div
          className={`footages-divider ${footagesDragging ? "is-dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("mediaPanel.resize")}
          onPointerDown={onFootagesDividerDown}
        />
      )}

      <main className="main-area">
        <ScriptTopBar view={view} onSetView={setView} save={save} />

        {notice && (
          <div className={`script-notice ${notice.kind === "error" ? "is-error" : ""}`}>{notice.text}</div>
        )}

        <NotebookEditor />
      </main>

      {splitOpen && (
        <>
          <div
            className={`split-divider ${dragging ? "is-dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("editor.resizeNotebook")}
            onPointerDown={onDividerDown}
          />
          <aside className="split-notebook" style={{ width: `${Math.round(splitRatio * 100)}%` }}>
            <NotebookPanel />
          </aside>
        </>
      )}

      <RightPanel collapsed={!rightOpen} save={save} />
    </div>
  );
}
