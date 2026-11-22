// @ts-check
// MCP resources: read-only snapshots of the app's data an external client can attach as context
// without a tool call (library, collections, notebooks, timelines…). Each one reads the same rpc
// channel the UI does. Reads go through no permission prompt: they are reads.

const { t } = require('../i18n');

const MAX_ITEMS = 500;
const JSON_TYPE = 'application/json';

/** @param {any} v */
const cap = (v) => (Array.isArray(v) && v.length > MAX_ITEMS ? { total: v.length, items: v.slice(0, MAX_ITEMS), truncated: true } : v);

/**
 * @typedef {{ uri:string, name:string, title:string, description:string, read:()=>Promise<any> }} StaticResource
 * @typedef {{ uriTemplate:string, name:string, title:string, description:string, match:RegExp, read:(m:RegExpMatchArray)=>Promise<any> }} TemplateResource
 */

/** @param {{ invoke:(ch:string, args?:any[])=>Promise<any>, jobs:any }} deps */
function createResources({ invoke, jobs }) {
  /** @type {StaticResource[]} */
  const statics = [
    { uri: 'netsurush://status', name: 'status', title: 'Resolve status', description: 'DaVinci Resolve connection, open project and timeline.', read: () => invoke('resolve:status') },
    { uri: 'netsurush://library', name: 'library', title: 'Media library', description: 'Imported rushes with absolute paths and metadata.', read: async () => cap(await invoke('library:list')) },
    { uri: 'netsurush://library/folders', name: 'library-folders', title: 'Library folders', description: 'Folder tree of the media library.', read: () => invoke('library:listFolders') },
    { uri: 'netsurush://collections', name: 'collections', title: 'Collections', description: 'Collections of shots (summaries). Read one with netsurush://collections/{id}.', read: () => invoke('collections:list') },
    { uri: 'netsurush://notebooks', name: 'notebooks', title: 'Notebooks', description: 'Notebooks of the Carnet module.', read: () => invoke('notebook:list') },
    { uri: 'netsurush://timelines', name: 'timelines', title: 'Resolve timelines', description: 'Timelines of the open Resolve project.', read: () => invoke('resolve:listTimelines') },
    { uri: 'netsurush://search/index', name: 'search-index', title: 'Search index', description: 'Files indexed for semantic search.', read: async () => cap(await invoke('search:indexed')) },
    { uri: 'netsurush://models', name: 'models', title: 'AI models', description: 'Installed and available AI models.', read: () => invoke('models:list') },
    { uri: 'netsurush://jobs', name: 'jobs', title: 'Agent jobs', description: 'Background jobs started by agent tool calls.', read: async () => jobs.list() },
  ];

  /** @type {TemplateResource[]} */
  const templates = [
    { uriTemplate: 'netsurush://collections/{id}', name: 'collection', title: 'Collection', description: 'One collection with all its shots.', match: /^netsurush:\/\/collections\/([^/]+)$/, read: (m) => invoke('collections:load', [decodeURIComponent(m[1])]) },
    { uriTemplate: 'netsurush://notebooks/{id}', name: 'notebook', title: 'Notebook', description: 'One notebook with its page tree.', match: /^netsurush:\/\/notebooks\/([^/]+)$/, read: (m) => invoke('notebook:load', [decodeURIComponent(m[1])]) },
    { uriTemplate: 'netsurush://pages/{id}', name: 'page', title: 'Notebook page', description: 'One notebook page with its content.', match: /^netsurush:\/\/pages\/([^/]+)$/, read: (m) => invoke('notebook:loadPage', [decodeURIComponent(m[1])]) },
    { uriTemplate: 'netsurush://jobs/{id}', name: 'job', title: 'Agent job', description: 'One background job with its result.', match: /^netsurush:\/\/jobs\/([^/]+)$/, read: async (m) => jobs.status(decodeURIComponent(m[1])) },
  ];

  function list() {
    return statics.map(({ uri, name, title, description }) => ({ uri, name, title, description, mimeType: JSON_TYPE }));
  }

  function listTemplates() {
    return templates.map(({ uriTemplate, name, title, description }) => ({ uriTemplate, name, title, description, mimeType: JSON_TYPE }));
  }

  /** @param {string} uri */
  async function read(uri) {
    const u = String(uri || '');
    /** @type {any} */
    let data;
    const hit = statics.find((r) => r.uri === u);
    if (hit) data = await hit.read();
    else {
      let found = false;
      for (const tpl of templates) {
        const m = u.match(tpl.match);
        if (m) { data = await tpl.read(m); found = true; break; }
      }
      if (!found) throw new Error(t('agentUnknownResource', { uri: u }));
    }
    return { contents: [{ uri: u, mimeType: JSON_TYPE, text: JSON.stringify(data ?? null) }] };
  }

  return { list, listTemplates, read };
}

module.exports = { createResources };
