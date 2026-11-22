// @ts-check
// The Carnet: Notion-like notebooks (several) -> a tree of pages -> page documents made of blocks
// (BlockNote JSON) with optional databases (table / kanban / gallery / calendar / list views).
// Deleting a page moves it to the notebook trash; only purge_page / empty_trash / delete_notebook are final.

const BLOCKS_NOTE = 'Page content = array of BlockNote blocks: {id?, type, props?, content?, children?}. '
  + 'content = inline array [{type:"text", text, styles?:{bold?,italic?,underline?,strike?,code?}}, {type:"link", href, content:[inline...]}, '
  + '{type:"pageMention", props:{pageId}}, {type:"dateMention", props:{...}}]. '
  + 'Types: paragraph, heading (props {level:1|2|3}), bulletListItem, numberedListItem, checkListItem (props {checked}), quote, codeBlock (props {language}), '
  + 'divider, callout (props {color, emoji}), toggle (props {open}; children = hidden content), '
  + 'database (props {dbId}, content none; the database lives in save_database), subpage (props {pageId} of a child page), '
  + 'image / video / audio / file / bookmark / youtube / embed (props {url,...}), equation, gallery. Omit ids on new blocks; nest with children.';

const DB_NOTE = 'Database = {id?, name, fields [{id, name, type: text|number|select|multiSelect|date|checkbox|url|checklist|createdTime|lastEditedTime, isPrimary? (first field = row title), '
  + 'options? [{id, label, color: gray|blue|green|yellow|orange|red|purple|pink}] (select types), numberFormat? plain|integer|percent|euro|dollar, dateFormat? friendly|iso|us|dmy, includeTime?}], '
  + 'rows [{id, cells: {fieldId: value}}] (select = optionId, multiSelect = optionId[], checkbox = bool, date = ISO string, number = number, text/url = string, checklist = [{id,label,done}]), '
  + 'views [{id, name, type: table|kanban|gallery|calendar|list, filters [], sorts [{fieldId, dir}], groupFieldId (kanban select field) | null}], activeViewId}. '
  + 'Reference it from a page with a block {type:"database", props:{dbId: <database id>}}.';

/** Flattens blocks to readable text, one line per block, indented by nesting. @param {any[]} blocks @param {number} depth @param {string[]} out */
function flatten(blocks, depth, out) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue;
    let text = '';
    if (Array.isArray(b.content)) {
      for (const c of b.content) {
        if (c && typeof c.text === 'string') text += c.text;
        else if (c && c.props && typeof c.props.label === 'string') text += c.props.label;
        else if (c && Array.isArray(c.content)) text += c.content.map((cc) => (cc && cc.text) || '').join('');
      }
    }
    const prefix = b.type === 'heading' ? `${'#'.repeat(Number(b.props && b.props.level) || 1)} `
      : b.type === 'bulletListItem' ? '- '
      : b.type === 'numberedListItem' ? '1. '
      : b.type === 'checkListItem' ? (b.props && b.props.checked ? '[x] ' : '[ ] ')
      : b.type === 'quote' ? '> '
      : '';
    const tag = ['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote'].includes(b.type) ? '' : `[${b.type}${b.props && (b.props.dbId || b.props.pageId || b.props.url) ? ` ${b.props.dbId || b.props.pageId || b.props.url}` : ''}] `;
    if (text || tag) out.push(`${'  '.repeat(depth)}${prefix}${tag}${text}`);
    if (Array.isArray(b.children) && b.children.length) flatten(b.children, depth + 1, out);
  }
}

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_notebook',
  summary: 'The Carnet: notebooks -> pages (a tree) -> databases. Use list to find notebooks, load for the page tree of one, load_page for the content of a page, '
    + 'save_page to write one. save_page REPLACES the whole content of the page: read it with load_page first and send back everything you keep. '
    + BLOCKS_NOTE,
  actions: {
    list: {
      risk: 'read',
      usage: 'list() — notebooks [{id, title, icon, kind: notes|project|script|research|journal, language, updatedAt}], most recent first',
      channel: 'notebook:list', map: (r) => ({ notebooks: r }),
    },
    load: {
      risk: 'read',
      usage: 'load(notebookId) — {notebook, pages [{id, parentId, title, icon, orderIdx, updatedAt}]}: the page tree WITHOUT page content (trash excluded)',
      channel: 'notebook:load', args: (a) => [a.notebookId],
      map: (r) => r || { ok: false, error: 'Notebook not found.' },
    },
    load_page: {
      risk: 'read',
      usage: 'load_page(id, plain?) — {page {id, notebookId, parentId, title, icon, cover, blocks}, databases {dbId: database}}. plain:true returns the content as flat text lines instead of block JSON (to read, not to edit)',
      channel: 'notebook:loadPage', args: (a) => [a.id],
      map: (r, a) => {
        if (!r) return { ok: false, error: 'Page not found.' };
        if (!a.plain) return r;
        const lines = /** @type {string[]} */ ([]);
        flatten(r.page && r.page.blocks, 0, lines);
        const { blocks, ...page } = r.page || {};
        return { page, text: lines.join('\n'), databases: r.databases };
      },
    },
    search: {
      risk: 'read',
      usage: 'search(notebookId, query) — full-text search in titles and blocks (max 50) [{pageId, title, snippet, blockId}]',
      channel: 'notebook:search', args: (a) => [a.notebookId, a.query],
      map: (r) => ({ hits: r }),
    },
    backlinks: {
      risk: 'read',
      usage: 'backlinks(notebookId, id) — pages of the notebook that @mention page `id`',
      channel: 'notebook:backlinks', args: (a) => [a.notebookId, a.id],
      map: (r) => ({ pages: r }),
    },
    trash_list: {
      risk: 'read',
      usage: 'trash_list(notebookId) — pages in the trash of a notebook',
      channel: 'notebook:trashList', args: (a) => [a.notebookId],
      map: (r) => ({ pages: r }),
    },
    save_notebook: {
      risk: 'write',
      usage: 'save_notebook(title, id?, icon?, kind?, language?) — create a notebook (no id) or update its title / icon. kind: notes (default) | project | research | journal; language: fr|en|es|de|ja|zh',
      channel: 'notebook:saveNotebook',
      args: (a) => [{ id: a.id, title: a.title, icon: a.icon, kind: a.kind, language: a.language }],
    },
    save_page: {
      risk: 'write',
      usage: 'save_page(notebookId, title, blocks[], id?, parentId?, icon?, cover?, orderIdx?) — create a page (no id) or REPLACE the title and entire content of page `id`. '
        + 'parentId nests it under another page (omit for the notebook root). Returns {id}. For a sub-page, also put a {type:"subpage", props:{pageId}} block in the parent to link it visibly',
      channel: 'notebook:savePage',
      args: (a) => [{
        id: a.id, notebookId: a.notebookId, parentId: a.parentId == null ? null : a.parentId, title: a.title,
        icon: a.icon, cover: a.cover, orderIdx: a.orderIdx, blocks: a.blocks || [],
      }],
    },
    duplicate_page: {
      risk: 'write',
      usage: 'duplicate_page(id) — copy a page with its sub-pages and databases; returns the new page id',
      channel: 'notebook:duplicatePage', args: (a) => [a.id],
    },
    save_database: {
      risk: 'write',
      usage: 'save_database(pageId, database) — create or REPLACE a database stored on a page (the whole object is replaced: load_page first to edit). '
        + DB_NOTE,
      channel: 'notebook:saveDatabase', args: (a) => [{ ...(a.database || {}), pageId: a.pageId }],
    },
    restore_page: {
      risk: 'write',
      usage: 'restore_page(id) — bring a page and its sub-pages back from the trash',
      channel: 'notebook:restorePage', args: (a) => [a.id],
    },
    delete_page: {
      risk: 'write',
      usage: 'delete_page(id) — move a page and its sub-pages to the trash (restore_page undoes it)',
      channel: 'notebook:deletePage', args: (a) => [a.id],
    },
    delete_notebook: {
      risk: 'destructive',
      usage: 'delete_notebook(id) — PERMANENTLY delete a notebook with all its pages and databases (the trash is not used)',
      channel: 'notebook:deleteNotebook', args: (a) => [a.id],
    },
    delete_database: {
      risk: 'destructive',
      usage: 'delete_database(id) — permanently delete a database (blocks pointing to it become empty)',
      channel: 'notebook:deleteDatabase', args: (a) => [a.id],
    },
    purge_page: {
      risk: 'destructive',
      usage: 'purge_page(id) — PERMANENTLY delete a page, its sub-pages and databases (not recoverable)',
      channel: 'notebook:purgePage', args: (a) => [a.id],
    },
    empty_trash: {
      risk: 'destructive',
      usage: 'empty_trash(notebookId) — permanently delete every page in the trash of a notebook',
      channel: 'notebook:emptyTrash', args: (a) => [a.notebookId],
    },
  },
  params: {
    id: { type: 'string', description: 'Notebook, page or database id (depends on the action)' },
    notebookId: { type: 'string' },
    pageId: { type: 'string', description: 'Page that owns a database' },
    parentId: { type: ['string', 'null'], description: 'Parent page id; null = notebook root' },
    title: { type: 'string' },
    icon: { type: ['string', 'null'], description: 'An emoji' },
    cover: { type: ['string', 'null'] },
    orderIdx: { type: 'number', description: 'Sort position among siblings (default: appended last)' },
    kind: { type: 'string', enum: ['notes', 'project', 'research', 'journal'] },
    language: { type: 'string', enum: ['fr', 'en', 'es', 'de', 'ja', 'zh'] },
    blocks: { type: 'array', items: { type: 'object' }, description: 'BlockNote blocks (see the tool summary)' },
    database: { type: 'object', description: 'Database object (see save_database)' },
    query: { type: 'string' },
    plain: { type: 'boolean', description: 'load_page: return flat text instead of block JSON' },
  },
};
