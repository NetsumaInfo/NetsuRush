import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { AudioLines, Folder, FolderOpen, Mic, Upload } from "lucide-react";
import { nr, type ScriptBlockMedia, type ScriptRecording } from "@/lib/bridge";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { AudioWaveThumb } from "./AudioWaveThumb";
import {
  NR_FOOTAGE_DND, SCRIPT_AUDIO_DIR_KEY, SCRIPT_RECORDINGS_DEST_KEY, SCRIPT_RECORDINGS_DIR_KEY, type FootageDrag,
} from "./scriptShared";
import { scriptEditorApi } from "./editor/editorApi";
import { useScript } from "./useScript";

function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return i18n.t("script:recordings.justNow");
  if (d < 3_600_000) return i18n.t("script:recordings.minutesAgo", { count: Math.floor(d / 60_000) });
  if (d < 86_400_000) return i18n.t("script:recordings.hoursAgo", { count: Math.floor(d / 3_600_000) });
  return new Date(ms).toLocaleDateString();
}

export function readScriptAudioDirs() {
  return {
    audio: localStorage.getItem(SCRIPT_AUDIO_DIR_KEY) || "",
    recordings: localStorage.getItem(SCRIPT_RECORDINGS_DIR_KEY) || "",
  };
}

interface AudioFolderSectionProps {
  kind: "folder" | "recording";
  embedded?: boolean;
  query?: string;
}

function AudioFolderSection({ kind, embedded = false, query = "" }: AudioFolderSectionProps) {
  const { t } = useTranslation("script");
  const recording = kind === "recording";
  const dirKey = recording ? SCRIPT_RECORDINGS_DIR_KEY : SCRIPT_AUDIO_DIR_KEY;
  const prefix = recording ? "recordings" : "audioFolder";
  const source: ScriptBlockMedia["source"] = recording ? "recording" : "folder";
  const [dir, setDir] = useState(() => localStorage.getItem(dirKey) || "");
  const [files, setFiles] = useState<ScriptRecording[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [destination, setDestination] = useState<"mediapool" | "folder">(() =>
    localStorage.getItem(SCRIPT_RECORDINGS_DEST_KEY) === "mediapool" ? "mediapool" : "folder",
  );
  const importedSignature = useRef("");

  const refresh = useCallback(async (selectedDir: string) => {
    const result = await nr.script?.recordings(selectedDir);
    if (!result) return;
    setError(result.ok ? null : (result.error ?? null));
    setFiles(result.files || []);
  }, []);

  useEffect(() => {
    if (!dir) { setFiles([]); return; }
    void refresh(dir);
    const timer = setInterval(() => void refresh(dir), 4000);
    return () => clearInterval(timer);
  }, [dir, refresh]);

  // « Media Pool » = le dossier prédéfini reste la destination disque du logiciel d'enregistrement,
  // puis tout nouveau fichier est importé automatiquement dans le bin Enregistrements de Resolve.
  useEffect(() => {
    if (!recording || destination !== "mediapool" || !files.length || busy) return;
    const signature = files.map((file) => `${file.path}:${file.mtime}`).join("|");
    if (signature === importedSignature.current) return;
    importedSignature.current = signature;
    setBusy(true);
    void nr.importToBin(files.map((file) => file.path), "Enregistrements").then((result) => {
      if (!result.ok) setNote(result.error || t("recordings.importFailed"));
    }).finally(() => setBusy(false));
  }, [busy, destination, files, recording, t]);

  const grouped = useMemo(() => {
    const map = new Map<string, ScriptRecording[]>();
    const normalizedQuery = query.trim().toLowerCase();
    for (const file of files.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery) || item.folder.toLowerCase().includes(normalizedQuery))) {
      const key = file.folder || "";
      map.set(key, [...(map.get(key) || []), file]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files, query]);

  function chooseDestination(value: "mediapool" | "folder") {
    localStorage.setItem(SCRIPT_RECORDINGS_DEST_KEY, value);
    importedSignature.current = "";
    setDestination(value);
    setNote(null);
  }

  async function pickDir() {
    const selected = await nr.chooseDir();
    if (!selected) return;
    localStorage.setItem(dirKey, selected);
    setDir(selected);
    setNote(null);
  }

  async function importAll() {
    if (!files.length || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await nr.importToBin(files.map((file) => file.path), "Audios");
      setNote(result.ok
        ? t(`${prefix}.imported`, { count: result.count ?? 0, skipped: result.skipped ?? 0 })
        : (result.error || t(`${prefix}.importFailed`)));
    } finally {
      setBusy(false);
    }
  }

  function attach(file: ScriptRecording) {
    const selected = useScript.getState().selected;
    if (!selected) return;
    scriptEditorApi.attachMedia(selected, { kind: "audio", filePath: file.path, label: file.name, fps: 0, source });
  }

  function onDragStart(event: React.DragEvent, file: ScriptRecording) {
    const payload: FootageDrag = { filePath: file.path, label: file.name, fps: 0, kind: "audio", source };
    event.dataTransfer.setData(NR_FOOTAGE_DND, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
  }

  const Icon = recording ? Mic : AudioLines;
  return (
    <section className={`rec-section ${embedded ? "is-embedded" : ""}`}>
      <div className="rec-head">
        {t(`${prefix}.title`)}
      </div>

      {recording && (
        <div className="recording-config">
          <span className="recording-config-label">{t("recordings.chooseFolder")}</span>
          <button type="button" className="recording-folder-button" onClick={() => void pickDir()}>
            {dir ? t("recordings.folder", { dir }) : t("recordings.chooseFolderEllipsis")}
          </button>
          <span className="recording-config-label">{t("mediaPanel.destination")}</span>
          <div className="recording-destination" aria-label={t("mediaPanel.destination")}>
            <button type="button" className={destination === "mediapool" ? "active" : ""} onClick={() => chooseDestination("mediapool")}>{t("audioSources.mediaPool")}</button>
            <button type="button" className={destination === "folder" ? "active" : ""} onClick={() => chooseDestination("folder")}>{t("audioSources.folder")}</button>
          </div>
        </div>
      )}

      {!dir ? null : error ? (
        <p className="rec-note">{error}</p>
      ) : !files.length ? (
        <p className="rec-note">{t(`${prefix}.empty`)}</p>
      ) : grouped.length === 0 ? (
        <p className="rec-note">{t("footages.noFile")}</p>
      ) : (
        <div className="rec-list">
          {grouped.map(([folder, folderFiles]) => (
            <div className="recording-folder" key={folder || "__root__"}>
              {folder && <div className="recording-folder-label"><Folder /> <span>{folder}</span> <small>{folderFiles.length}</small></div>}
              {folderFiles.map((file) => <ContextMenu key={file.path}>
              <ContextMenuTrigger render={<div className="rec-row" draggable role="button" tabIndex={0} onDragStart={(event) => onDragStart(event, file)} onClick={() => attach(file)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); attach(file); } }} />}>
                <AudioWaveThumb path={file.path} compact />
                <span className="rec-info">
                  <span className="rec-name">{file.name}</span>
                  <span className="rec-meta">{recording ? ago(file.mtime) : t("audioFolder.audioFile")}</span>
                </span>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => attach(file)}><Icon /> {t(`${prefix}.attach`)}</ContextMenuItem>
                <ContextMenuItem onClick={() => void importAll()} disabled={busy}><Upload /> {t(`${prefix}.importMediaPoolShort`)}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => void nr.openPath(file.path)}><FolderOpen /> {t(`${prefix}.openFile`)}</ContextMenuItem>
              </ContextMenuContent>
              </ContextMenu>)}
            </div>
          ))}
        </div>
      )}
      {note && <p className="rec-note">{note}</p>}
    </section>
  );
}

export function RecordingsSection({ query = "" }: { query?: string }) {
  return <AudioFolderSection kind="recording" query={query} />;
}
