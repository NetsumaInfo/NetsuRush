import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { nr, type Clip, type ScriptBlockMedia } from "@/lib/bridge";
import { useApp } from "@/store";
import { basename } from "@/lib/utils";
import { isAudioPath } from "../scriptShared";
import { readScriptAudioDirs } from "../RecordingsSection";
import { scriptEditorApi } from "./editorApi";

export interface MentionState { query: string; from: number; to: number; left: number; top: number }
export interface MentionPage { kind: "page"; id: string; title: string; icon: string | null }
export interface MentionMedia {
  kind: "media";
  id: string;
  title: string;
  path: string;
  mediaKind: "video" | "audio";
  fps: number;
  source: ScriptBlockMedia["source"];
}
export type MentionHit = MentionPage | MentionMedia;

function mediaHit(clip: Clip, source: MentionMedia["source"]): MentionMedia {
  return {
    kind: "media",
    id: `${source}:${clip.path}`,
    title: clip.name || basename(clip.path),
    path: clip.path,
    mediaKind: isAudioPath(clip.path) ? "audio" : "video",
    fps: parseFloat(clip.fps || "") || (isAudioPath(clip.path) ? 0 : 24),
    source,
  };
}

export function useMentionMenu(editorRef: RefObject<Editor | null>) {
  const { t } = useTranslation("script");
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pages, setPages] = useState<MentionPage[]>([]);
  const [media, setMedia] = useState<MentionMedia[]>([]);
  const mentionRef = useRef<MentionState | null>(null);
  const indexRef = useRef(0);
  useEffect(() => { mentionRef.current = mention; }, [mention]);
  useEffect(() => { indexRef.current = mentionIndex; }, [mentionIndex]);

  const loadedFor = useRef<MentionState | null>(null);
  useEffect(() => {
    if (!mention || loadedFor.current) return;
    loadedFor.current = mention;
    void (async () => {
      try {
        const [books, pool] = await Promise.all([
          nr.notebook?.list() ?? Promise.resolve([]),
          nr.script?.mediaPool() ?? Promise.resolve({ connected: false, clips: [] }),
        ]);
        const allPages: MentionPage[] = [];
        for (const book of books) {
          const loaded = await nr.notebook?.load(book.id);
          for (const page of loaded?.pages ?? []) allPages.push({ kind: "page", id: page.id, title: page.title || t("common.untitled"), icon: page.icon ?? null });
        }
        setPages(allPages);

        const local = useApp.getState().localClips.map((clip) => mediaHit(clip, "folder"));
        const fromPool = (pool.clips ?? []).map((clip) => mediaHit(clip, "mediapool"));
        const dirs = readScriptAudioDirs();
        const [folderFiles, recordingFiles] = await Promise.all([
          dirs.audio ? nr.script?.recordings(dirs.audio) : Promise.resolve(null),
          dirs.recordings ? nr.script?.recordings(dirs.recordings) : Promise.resolve(null),
        ]);
        const folder = (folderFiles?.files ?? []).map((file) => mediaHit({ name: file.name, path: file.path, duration: null, fps: null, resolution: null, format: null, bin: null }, "folder"));
        const recordings = (recordingFiles?.files ?? []).map((file) => mediaHit({ name: file.name, path: file.path, duration: null, fps: null, resolution: null, format: null, bin: null }, "recording"));
        const seen = new Set<string>();
        setMedia([...fromPool, ...local, ...folder, ...recordings].filter((hit) => {
          const key = hit.path.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
      } catch {
        setPages([]);
        setMedia([]);
      }
    })();
  }, [mention, t]);
  useEffect(() => { if (!mention) loadedFor.current = null; }, [mention]);

  const hits = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    const matches = (title: string, path = "") => !query || title.toLowerCase().includes(query) || path.toLowerCase().includes(query);
    const mediaHits = media.filter((hit) => matches(hit.title, hit.path));
    const pageHits = pages.filter((page) => matches(page.title));
    return [...mediaHits, ...pageHits].slice(0, 10);
  }, [media, mention, pages]);
  const hitsRef = useRef<MentionHit[]>([]);
  useEffect(() => { hitsRef.current = hits; }, [hits]);

  const refreshMention = useCallback((editor: Editor) => {
    const sel = editor.state.selection;
    if (!sel.empty || !sel.$from.parent.isTextblock) { setMention(null); return; }
    const $from = sel.$from;
    const before = editor.state.doc.textBetween($from.start(), $from.pos, "\n", "\n");
    const match = /(^|\s)@([^@\s]*)$/.exec(before);
    if (!match) { setMention(null); return; }
    const query = match[2];
    const to = $from.pos;
    const from = to - (query.length + 1);
    const coords = editor.view.coordsAtPos(to);
    setMention({ query, from, to, left: coords.left, top: coords.bottom });
    setMentionIndex(0);
  }, []);

  const applyMention = useCallback((hit: MentionHit) => {
    const editor = editorRef.current;
    const state = mentionRef.current;
    if (!editor || !state) return;
    if (hit.kind === "page") {
      editor.chain().focus().deleteRange({ from: state.from, to: state.to }).insertContent({ type: "pageMention", attrs: { pageId: hit.id, label: hit.title } }).run();
    } else {
      const $pos = editor.state.doc.resolve(state.from);
      let depth = $pos.depth;
      while (depth > 0 && !$pos.node(depth).attrs.blockId) depth--;
      const blockId = depth > 0 ? String($pos.node(depth).attrs.blockId) : "";
      editor.chain().focus().deleteRange({ from: state.from, to: state.to }).run();
      if (blockId) scriptEditorApi.attachMedia(blockId, { kind: hit.mediaKind, filePath: hit.path, label: hit.title, fps: hit.fps, source: hit.source });
    }
    setMention(null);
  }, [editorRef]);
  const applyRef = useRef(applyMention);
  useEffect(() => { applyRef.current = applyMention; }, [applyMention]);

  const handleMentionKey = useCallback((event: KeyboardEvent): boolean => {
    if (!mentionRef.current) return false;
    const list = hitsRef.current;
    if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((index) => Math.min(index + 1, list.length - 1)); return true; }
    if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((index) => Math.max(index - 1, 0)); return true; }
    if (event.key === "Enter" && list.length) { event.preventDefault(); applyRef.current(list[indexRef.current]); return true; }
    if (event.key === "Escape") { event.preventDefault(); setMention(null); return true; }
    return false;
  }, []);

  return { mention, hits, mentionIndex, setMentionIndex, refreshMention, applyMention, handleMentionKey };
}
