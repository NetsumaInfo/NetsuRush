// Sidebar droite : menu d'actions (Historique des versions), puis sections empilées —
// Table des matières (saut au clic + cases d'export partiel), Tags (filtre + favoris Ctrl+1…9),
// À faire (état coché persisté), rappel des raccourcis en pied.

import { ChevronsRight, Eye, EyeOff, Star, CornerDownRight, Check, Filter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem,
} from "@/components/ui/context-menu";
import { docSections, docTags, fmtDuration, stripHtml } from "./scriptShared";
import { useScript } from "./useScript";
import { scriptEditorApi } from "./editor/editorApi";

interface Props {
  collapsed: boolean;
  save?: () => Promise<void> | void; // conservé pour compat d'appel (l'historique vit dans le menu ⋯)
}

export function RightPanel({ collapsed }: Props) {
  const { t: tr } = useTranslation("script");
  const doc = useScript((s) => s.doc);
  const tagFilter = useScript((s) => s.tagFilter);
  const setTagFilter = useScript((s) => s.setTagFilter);
  const setSelected = useScript((s) => s.setSelected);
  const favTags = useScript((s) => s.favTags);
  const toggleFavTag = useScript((s) => s.toggleFavTag);
  const sectionSel = useScript((s) => s.sectionSel);
  const toggleSectionSel = useScript((s) => s.toggleSectionSel);
  const hideTodos = useScript((s) => s.hideTodos);
  const toggleHideTodos = useScript((s) => s.toggleHideTodos);

  const tags = docTags(doc);
  const todos = (doc?.blocks ?? []).filter((b) => b.type === "todo");
  const todosLeft = todos.filter((t) => !t.checked).length;
  const sections = docSections(doc);
  const tagCount = (t: string) => (doc?.blocks ?? []).filter((b) => b.tags.includes(t)).length;

  function jumpTo(id: string) {
    setSelected(id);
    scriptEditorApi.focusBlock(id);
  }

  return (
    <aside className={`sidebar-right ${collapsed ? "collapsed" : ""}`} aria-label={tr("right.ariaLabel")}>
      <header className="panel-header">
        <span className="sidebar-title">{tr("right.document")}</span>
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="collapse-btn" onClick={() => useScript.getState().toggleRight()} />}><ChevronsRight /></TooltipTrigger>
          <TooltipContent>{tr("right.hide")}</TooltipContent>
        </Tooltip>
      </header>

      <div className="panel-content">
        <div className="panel-section">
          <div className="panel-section-title">{tr("right.toc")}</div>
          {sections.length === 0 ? (
            <p className="empty-note">{tr("right.tocEmpty")}</p>
          ) : (
            <>
              {sections.map((sec) => (
                <ContextMenu key={sec.id}>
                  <ContextMenuTrigger render={<div className={`toc-row toc-l${sec.level} ${sectionSel.includes(sec.id) ? "selected" : ""}`} />}>
                    <input
                      type="checkbox"
                      className="nr-check"
                      checked={sectionSel.includes(sec.id)}
                      onChange={() => toggleSectionSel(sec.id)}
                      aria-label={tr("right.exportSection", { title: sec.title })}
                    />
                    <button type="button"
                      className="toc-title"
                      onClick={() => jumpTo(sec.id === "__intro__" ? sec.blockIds[0] ?? "" : sec.id)}
                    >
                      {sec.title}
                    </button>
                    <span className="toc-meta">{sec.seconds > 0 ? fmtDuration(sec.seconds) : ""}</span>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => jumpTo(sec.id === "__intro__" ? sec.blockIds[0] ?? "" : sec.id)}><CornerDownRight /> {tr("right.goTo")}</ContextMenuItem>
                    <ContextMenuItem onClick={() => toggleSectionSel(sec.id)}><Check /> {sectionSel.includes(sec.id) ? tr("right.uncheckExport") : tr("right.checkExport")}</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
              {sectionSel.length > 0 && (
                <p className="empty-note" style={{ marginTop: 8 }}>
                  {tr("right.sectionsSelected", { count: sectionSel.length })}
                </p>
              )}
            </>
          )}
        </div>

        <div className="panel-section">
          <div className="panel-section-title">{tr("right.tags")}</div>
          {tags.length === 0 ? (
            <p className="empty-note">{tr("right.tagsEmpty")}</p>
          ) : (
            <div className="tag-grid">
              {tags.map((t) => {
                const favIdx = favTags.indexOf(t);
                return (
                  <ContextMenu key={t}>
                    <ContextMenuTrigger render={<span className={`tag-chip ${tagFilter === t ? "active" : ""}`} />}>
                      <button type="button" className="tag-chip-label" onClick={() => setTagFilter(t)}>
                        {t} <span className="count">{tagCount(t)}</span>
                        {favIdx >= 0 && <span className="fav-kbd">⌃{favIdx + 1}</span>}
                      </button>
                      <Tooltip>
                        <TooltipTrigger render={<button type="button" className={`fav-star ${favIdx >= 0 ? "active" : ""}`} onClick={() => toggleFavTag(t)} />}>
                          <Star className="size-3" />
                        </TooltipTrigger>
                        <TooltipContent>{favIdx >= 0 ? tr("right.removeFavorite") : tr("right.favoriteHint")}</TooltipContent>
                      </Tooltip>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => setTagFilter(t)}><Filter /> {tr("right.filter")}</ContextMenuItem>
                      <ContextMenuItem onClick={() => toggleFavTag(t)}><Star /> {favIdx >= 0 ? tr("right.removeFavorite") : tr("right.addFavorite")}</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel-section">
          <div className="panel-section-title todo-title-row">
            <span>{tr("right.todo")}{todosLeft ? ` · ${todosLeft}` : ""}</span>
            {todos.length > 0 && (
              <Tooltip>
                <TooltipTrigger render={<button type="button" className={`todo-eye ${hideTodos ? "active" : ""}`} onClick={toggleHideTodos} />}>
                  {hideTodos ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </TooltipTrigger>
                <TooltipContent>{hideTodos ? tr("right.showTodos") : tr("right.hideTodos")}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {todos.length === 0 ? (
            <p className="empty-note">{tr("right.todoEmpty")}</p>
          ) : (
            todos.map((t) => (
              <ContextMenu key={t.id}>
                <ContextMenuTrigger render={<div className={`todo-row ${t.checked ? "done" : ""}`} />}>
                  <input type="checkbox" className="nr-check" checked={!!t.checked} onChange={() => scriptEditorApi.toggleTodo(t.id)} aria-label={tr("right.done")} />
                  <button type="button" className="todo-text" onClick={() => jumpTo(t.id)}>{stripHtml(t.text) || tr("right.task")}</button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => jumpTo(t.id)}><CornerDownRight /> {tr("right.goTo")}</ContextMenuItem>
                  <ContextMenuItem onClick={() => scriptEditorApi.toggleTodo(t.id)}><Check /> {t.checked ? tr("right.markTodo") : tr("right.markDone")}</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))
          )}
        </div>

      </div>
    </aside>
  );
}
