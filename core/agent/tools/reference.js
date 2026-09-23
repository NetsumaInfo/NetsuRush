// @ts-check
// "Reference board" tool exposed to the AI agent: read/write the mood-board scenes and send media to
// it (local images / videos, or remote media resolved from a URL). Reuses the SAME store as the
// reference:* channels (core/reference.js) and the SAME push channel as "Send to board" (broadcast
// 'reference:push' {type:'path',path,title}) → the live board (Reference tab or detached window)
// places the item. Compound dispatcher: 1 tool + an `action` param.

const { t } = require('../../i18n');

/**
 * @param {{ refStore:any, broadcast:(ch:string,p:any)=>void }} deps
 * @returns {import('./registry').ToolDef[]}
 */
function createReferenceTools(deps) {
  const { refStore, broadcast } = deps;
  const ok = (/** @type {any} */ data) => ({ ok: true, ...(data && typeof data === 'object' ? data : { value: data }) });

  // Pousse un chemin disque vers le board vivant (même contrat que useReferencePush).
  const pushPath = (/** @type {string} */ p, /** @type {string} */ title) =>
    broadcast('reference:push', { type: 'path', path: p, title: title || p.replace(/^.*[\\/]/, '') });

  return [
    {
      name: 'board',
      description: 'Reference board (mood-board). action: list_scenes | load_scene(id) | '
        + 'save_scene(scene) | delete_scene(id) | add_media(paths[],titles?) | add_url(url,title?). '
        + 'add_media sends local image/video files to the open board. add_url downloads a '
        + 'remote medium (web page, CDN, GIF) and then adds it. add_media/add_url only work when the '
        + 'board is open (Reference tab or detached window).',
      risk: 'write',
      riskFor: (/** @type {any} */ a) => (a.action === 'list_scenes' || a.action === 'load_scene' ? 'read' : a.action === 'delete_scene' ? 'destructive' : 'write'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_scenes', 'load_scene', 'save_scene', 'delete_scene', 'add_media', 'add_url'] },
          id: { type: 'string' },
          scene: { type: 'object', description: '{ id?, name, items[], view? }' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Absolute image/video paths' },
          titles: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['action'],
      },
      handler: async (/** @type {any} */ a) => {
        switch (a.action) {
          case 'list_scenes': return ok({ scenes: refStore.listScenes() });
          case 'load_scene': return ok({ scene: refStore.loadScene(String(a.id)) });
          case 'save_scene': return refStore.saveScene(a.scene || {});
          case 'delete_scene': return refStore.deleteScene(String(a.id));
          case 'add_media': {
            const paths = a.paths || [];
            paths.forEach((/** @type {string} */ p, /** @type {number} */ i) => pushPath(p, (a.titles || [])[i]));
            return ok({ added: paths.length });
          }
          case 'add_url': {
            const r = await refStore.resolveMedia(String(a.url || ''));
            if (!r || !r.ok || !r.path) return { ok: false, error: (r && r.error) || t('mediaMissing') };
            pushPath(r.path, a.title);
            return ok({ added: 1, path: r.path, kind: r.kind });
          }
          default: throw new Error(t('agentUnknownAction', { action: String(a.action) }));
        }
      },
    },
  ];
}

module.exports = { createReferenceTools };
