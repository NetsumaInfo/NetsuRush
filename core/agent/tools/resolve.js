// @ts-check
// Catalogue Resolve exposé à l'agent IA, porté de davinci-resolve-mcp (MIT) sur NOTRE pont
// (resolve-proxy : resolve.GetProjectManager()…, tout awaité). Surfacé en DISPATCHERS COMPOUND :
// un outil par domaine + un paramètre `action` (anti-flood du contexte LLM, recommandation du repo MCP).
// Le risque est calculé par action (riskFor) → la porte de permission ne confirme que les écritures.
//
// Invariants timeline frame-accurate (cf. core/timeline.js) NON dupliqués ici : pour bâtir une
// timeline depuis des plans, l'agent utilise l'outil `build_timeline` (module netsurush, frame-math).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { getResolve } = require('../../resolve-proxy');

async function ctx() {
  const resolve = await getResolve();
  if (!resolve) throw new Error('Resolve injoignable (pont Python / scripting externe = Local ?)');
  const pm = await resolve.GetProjectManager();
  const proj = pm ? await pm.GetCurrentProject() : null;
  return { resolve, pm, proj };
}
async function needProj() {
  const c = await ctx();
  if (!c.proj) throw new Error('aucun projet ouvert');
  return c;
}
async function curTimeline() {
  const c = await needProj();
  const tl = await c.proj.GetCurrentTimeline();
  if (!tl) throw new Error('aucune timeline ouverte');
  return { ...c, tl };
}
const ok = (/** @type {any} */ data) => ({ ok: true, ...(data && typeof data === 'object' ? data : { value: data }) });
const READ = (/** @type {Set<string>} */ s) => (/** @type {any} */ a) => (s.has(a && a.action) ? 'read' : 'write');

/**
 * @param {{ guarded:(fn:any)=>any, ev:any }} deps
 * @returns {import('./registry').ToolDef[]}
 */
function createResolveTools(deps) {
  const { guarded } = deps;
  const g = (/** @type {Function} */ fn) => guarded(fn);

  return [
    // ---- Application / pages -------------------------------------------------
    {
      name: 'resolve_app',
      description: 'Application Resolve. action: status | version | get_page | switch_page (page: media|cut|edit|fusion|color|fairlight|deliver).',
      risk: 'read',
      riskFor: READ(new Set(['status', 'version', 'get_page'])),
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['status', 'version', 'get_page', 'switch_page'] }, page: { type: 'string' } },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { resolve, proj } = await ctx();
        switch (a.action) {
          case 'version': return ok({ version: await resolve.GetVersionString() });
          case 'get_page': return ok({ page: await resolve.GetCurrentPage() });
          case 'switch_page': return ok({ switched: await resolve.OpenPage(String(a.page || 'edit')) });
          case 'status':
          default: {
            const tl = proj ? await proj.GetCurrentTimeline() : null;
            return ok({ connected: true, version: await resolve.GetVersionString(), page: await resolve.GetCurrentPage(),
              project: proj ? await proj.GetName() : null, timeline: tl ? await tl.GetName() : null });
          }
        }
      }),
    },

    // ---- Projet --------------------------------------------------------------
    {
      name: 'resolve_project',
      description: 'Projet Resolve. action: info | list | open(name) | create(name) | save | close | '
        + 'get_setting(key) | set_setting(key,value).',
      risk: 'write',
      riskFor: READ(new Set(['info', 'list', 'get_setting'])),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['info', 'list', 'open', 'create', 'save', 'close', 'get_setting', 'set_setting'] },
          name: { type: 'string' }, key: { type: 'string' }, value: {},
        },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { pm, proj } = await ctx();
        switch (a.action) {
          case 'list': return ok({ projects: await pm.GetProjectListInCurrentFolder() });
          case 'open': return ok({ opened: !!(await pm.LoadProject(String(a.name))) });
          case 'create': return ok({ created: !!(await pm.CreateProject(String(a.name))) });
          case 'save': return ok({ saved: await pm.SaveProject() });
          case 'close': { if (!proj) throw new Error('aucun projet'); return ok({ closed: await pm.CloseProject(proj) }); }
          case 'get_setting': { if (!proj) throw new Error('aucun projet'); return ok({ value: await proj.GetSetting(String(a.key)) }); }
          case 'set_setting': { if (!proj) throw new Error('aucun projet'); return ok({ set: await proj.SetSetting(String(a.key), String(a.value)) }); }
          case 'info':
          default: {
            if (!proj) return ok({ project: null });
            return ok({ name: await proj.GetName(), timelineCount: await proj.GetTimelineCount() });
          }
        }
      }),
    },

    // ---- Rendu / Deliver -----------------------------------------------------
    {
      name: 'resolve_render',
      description: 'File de rendu / Deliver. action: formats | codecs | resolutions | current_format_codec | '
        + 'set_format_codec(format,codec) | jobs | add_job | start | stop | status(jobId) | set_settings(settings). '
        + 'start lance un rendu (produit des fichiers).',
      risk: 'write',
      riskFor: (/** @type {any} */ a) => {
        if (['formats', 'codecs', 'resolutions', 'current_format_codec', 'jobs', 'status'].includes(a.action)) return 'read';
        if (a.action === 'start') return 'destructive';
        return 'write';
      },
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['formats', 'codecs', 'resolutions', 'current_format_codec', 'set_format_codec', 'jobs', 'add_job', 'start', 'stop', 'status', 'set_settings'] },
          format: { type: 'string' }, codec: { type: 'string' }, jobId: { type: 'string' }, settings: { type: 'object' },
        },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { proj } = await needProj();
        switch (a.action) {
          case 'formats': return ok({ formats: await proj.GetRenderFormats() });
          case 'codecs': return ok({ codecs: await proj.GetRenderCodecs(String(a.format || '')) });
          case 'resolutions': return ok({ resolutions: await proj.GetRenderResolutions(String(a.format || ''), String(a.codec || '')) });
          case 'current_format_codec': return ok({ current: await proj.GetCurrentRenderFormatAndCodec() });
          case 'set_format_codec': return ok({ set: await proj.SetCurrentRenderFormatAndCodec(String(a.format), String(a.codec)) });
          case 'jobs': return ok({ jobs: await proj.GetRenderJobList() });
          case 'add_job': return ok({ jobId: await proj.AddRenderJob() });
          case 'set_settings': return ok({ set: await proj.SetRenderSettings(a.settings || {}) });
          case 'start': return ok({ started: a.jobId ? await proj.StartRendering([String(a.jobId)]) : await proj.StartRendering() });
          case 'stop': { await proj.StopRendering(); return ok({ stopped: true }); }
          case 'status': return ok({ status: await proj.GetRenderJobStatus(String(a.jobId)) });
          default: throw new Error(`action rendu inconnue : ${a.action}`);
        }
      }),
    },

    // ---- Timeline ------------------------------------------------------------
    {
      name: 'resolve_timeline',
      description: 'Timeline courante / liste. action: list | info | set_current(name) | duplicate(name) | '
        + 'get_timecode | set_timecode(timecode) | add_track(trackType) | delete_track(trackType,index) | '
        + 'remove_audio | set_track_enable(trackType,index,enabled) | get_markers | add_marker(frame,color,name,note,duration) | '
        + 'delete_marker_at_frame(frame) | delete_markers_by_color(color) | get_setting(key) | set_setting(key,value) | export(path,format). '
        + 'SUPPRIMER L’AUDIO est SUPPORTÉ : action `remove_audio` retire RÉELLEMENT le son — elle supprime '
        + 'tous les CLIPS audio de la timeline (puis tente d’enlever les pistes vides). Ce n’est PAS un mute. '
        + 'duplicate crée une copie de la timeline et bascule dessus.',
      risk: 'write',
      // Tout est lecture ou écriture TIMELINE : ces actions ne touchent jamais les fichiers d'origine
      // (montage réversible dans Resolve). Aucune n'est « destructive » → pas de confirmation en mode ask.
      riskFor: READ(new Set(['list', 'info', 'get_timecode', 'get_markers', 'get_setting'])),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'info', 'set_current', 'duplicate', 'get_timecode', 'set_timecode', 'add_track', 'delete_track', 'remove_audio', 'set_track_enable', 'get_markers', 'add_marker', 'delete_marker_at_frame', 'delete_markers_by_color', 'get_setting', 'set_setting', 'export'] },
          name: { type: 'string' }, timecode: { type: 'string' }, trackType: { type: 'string', enum: ['video', 'audio', 'subtitle'] },
          index: { type: 'number' }, enabled: { type: 'boolean' },
          frame: { type: 'number' }, color: { type: 'string' }, note: { type: 'string' }, duration: { type: 'number' },
          key: { type: 'string' }, value: {}, path: { type: 'string' }, format: { type: 'string' },
        },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { proj } = await needProj();
        if (a.action === 'list') {
          const n = await proj.GetTimelineCount();
          const cur = await proj.GetCurrentTimeline();
          const curName = cur ? await cur.GetName() : null;
          const timelines = [];
          for (let i = 1; i <= n; i++) { const t = await proj.GetTimelineByIndex(i); const nm = await t.GetName(); timelines.push({ name: nm, current: nm === curName }); }
          return ok({ current: curName, timelines });
        }
        if (a.action === 'set_current') {
          const n = await proj.GetTimelineCount();
          for (let i = 1; i <= n; i++) { const t = await proj.GetTimelineByIndex(i); if ((await t.GetName()) === a.name) return ok({ set: await proj.SetCurrentTimeline(t) }); }
          throw new Error(`timeline introuvable : ${a.name}`);
        }
        const tl = await proj.GetCurrentTimeline();
        if (!tl) throw new Error('aucune timeline ouverte');
        switch (a.action) {
          case 'info': return ok({ name: await tl.GetName(), startFrame: await tl.GetStartFrame(), endFrame: await tl.GetEndFrame(), videoTracks: await tl.GetTrackCount('video'), audioTracks: await tl.GetTrackCount('audio') });
          case 'duplicate': {
            const newName = a.name || `${await tl.GetName()} — copie IA`;
            const nt = await tl.DuplicateTimeline(newName);
            if (nt) await proj.SetCurrentTimeline(nt);
            return ok({ duplicated: !!nt, name: newName });
          }
          case 'get_timecode': return ok({ timecode: await tl.GetCurrentTimecode() });
          case 'set_timecode': return ok({ set: await tl.SetCurrentTimecode(String(a.timecode)) });
          case 'add_track': return ok({ added: await tl.AddTrack(String(a.trackType || 'video')) });
          case 'delete_track': return ok({ deleted: await tl.DeleteTrack(String(a.trackType || 'audio'), a.index | 0 || 1) });
          case 'remove_audio': {
            // RETIRE RÉELLEMENT l'audio du montage. L'API scripting n'a pas de « delete track » fiable,
            // mais elle sait supprimer les CLIPS : on vide chaque piste audio (GetItemListInTrack →
            // DeleteClips), ce qui enlève le son. Puis on tente de retirer les pistes désormais vides
            // (DeleteTrack si la version l'expose). Repli ultime : désactiver (mute) si rien d'autre.
            const n = await tl.GetTrackCount('audio');
            let clipsDeleted = 0;
            for (let i = 1; i <= n; i++) {
              const items = (await tl.GetItemListInTrack('audio', i)) || [];
              if (items.length) { try { if (await tl.DeleteClips(items, false)) clipsDeleted += items.length; } catch { /* skip */ } }
            }
            let tracksRemoved = 0;
            for (let i = n; i >= 1; i--) { try { if (await tl.DeleteTrack('audio', i)) tracksRemoved++; } catch { /* DeleteTrack absent */ } }
            let disabled = 0;
            if (!clipsDeleted && !tracksRemoved && n > 0) {
              for (let i = 1; i <= n; i++) { try { if (await tl.SetTrackEnable('audio', i, false)) disabled++; } catch { /* skip */ } }
            }
            return ok({ audioTracks: n, clipsDeleted, tracksRemoved, disabled });
          }
          case 'set_track_enable': return ok({ set: await tl.SetTrackEnable(String(a.trackType || 'audio'), a.index | 0 || 1, a.enabled !== false) });
          case 'get_markers': return ok({ markers: await tl.GetMarkers() });
          case 'add_marker': return ok({ added: await tl.AddMarker(a.frame | 0, String(a.color || 'Blue'), String(a.name || ''), String(a.note || ''), a.duration | 0 || 1, '') });
          case 'delete_marker_at_frame': return ok({ deleted: await tl.DeleteMarkerAtFrame(a.frame | 0) });
          case 'delete_markers_by_color': return ok({ deleted: await tl.DeleteMarkersByColor(String(a.color)) });
          case 'get_setting': return ok({ value: await tl.GetSetting(String(a.key)) });
          case 'set_setting': return ok({ set: await tl.SetSetting(String(a.key), String(a.value)) });
          case 'export': return ok({ exported: await tl.Export(String(a.path), String(a.format || 'AAF')) });
          default: throw new Error(`action timeline inconnue : ${a.action}`);
        }
      }),
    },

    // ---- Media Pool ----------------------------------------------------------
    {
      name: 'resolve_media_pool',
      description: 'Media Pool. action: list_clips | import(paths) | append_to_timeline(paths) | '
        + 'create_empty_timeline(name) | create_timeline_from_clips(name,paths) | add_subfolder(name) | '
        + 'set_current_folder(name) | delete_clips(paths). delete_clips est destructif.',
      risk: 'write',
      riskFor: (/** @type {any} */ a) => (a.action === 'list_clips' ? 'read' : a.action === 'delete_clips' ? 'destructive' : 'write'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_clips', 'import', 'append_to_timeline', 'create_empty_timeline', 'create_timeline_from_clips', 'add_subfolder', 'set_current_folder', 'delete_clips'] },
          name: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { resolve, proj } = await needProj();
        const mp = await proj.GetMediaPool();
        const root = await mp.GetRootFolder();
        const findItems = async (/** @type {string[]} */ paths) => {
          const want = new Set(paths || []);
          const found = [];
          const walk = async (/** @type {any} */ folder) => {
            for (const it of (await folder.GetClipList()) || []) {
              try { if (want.has(await it.GetClipProperty('File Path'))) found.push(it); } catch { /* skip */ }
            }
            for (const sub of (await folder.GetSubFolderList()) || []) await walk(sub);
          };
          await walk(root);
          return found;
        };
        switch (a.action) {
          case 'import': { const ms = await resolve.GetMediaStorage(); const items = await ms.AddItemListToMediaPool(a.paths || []); return ok({ count: items ? items.length : 0 }); }
          case 'append_to_timeline': { const items = await findItems(a.paths); const r = await mp.AppendToTimeline(items); return ok({ appended: Array.isArray(r) ? r.length : !!r }); }
          case 'create_empty_timeline': return ok({ created: !!(await mp.CreateEmptyTimeline(String(a.name || 'Timeline'))) });
          case 'create_timeline_from_clips': { const items = await findItems(a.paths); return ok({ created: !!(await mp.CreateTimelineFromClips(String(a.name || 'Timeline'), items)) }); }
          case 'add_subfolder': return ok({ created: !!(await mp.AddSubFolder(root, String(a.name))) });
          case 'set_current_folder': { for (const sub of (await root.GetSubFolderList()) || []) if ((await sub.GetName()) === a.name) return ok({ set: await mp.SetCurrentFolder(sub) }); throw new Error('dossier introuvable'); }
          case 'delete_clips': { const items = await findItems(a.paths); return ok({ deleted: await mp.DeleteClips(items) }); }
          case 'list_clips':
          default: {
            const clips = [];
            const walk = async (/** @type {any} */ folder, /** @type {string} */ prefix) => {
              for (const it of (await folder.GetClipList()) || []) {
                try { clips.push({ name: await it.GetName(), path: await it.GetClipProperty('File Path'), bin: prefix }); } catch { /* skip */ }
              }
              for (const sub of (await folder.GetSubFolderList()) || []) await walk(sub, (prefix ? prefix + '/' : '') + (await sub.GetName()));
            };
            await walk(root, '');
            return ok({ clips });
          }
        }
      }),
    },

    // ---- Media Storage (système de fichiers) ---------------------------------
    {
      name: 'resolve_media_storage',
      description: 'Stockage média (disque vu par Resolve). action: volumes | subfolders(path) | files(path) | add_to_media_pool(paths).',
      risk: 'read',
      riskFor: READ(new Set(['volumes', 'subfolders', 'files'])),
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['volumes', 'subfolders', 'files', 'add_to_media_pool'] }, path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { resolve } = await ctx();
        const ms = await resolve.GetMediaStorage();
        switch (a.action) {
          case 'volumes': return ok({ volumes: await ms.GetMountedVolumeList() });
          case 'subfolders': return ok({ subfolders: await ms.GetSubFolderList(String(a.path)) });
          case 'files': return ok({ files: await ms.GetFileList(String(a.path)) });
          case 'add_to_media_pool': { const items = await ms.AddItemListToMediaPool(a.paths || []); return ok({ count: items ? items.length : 0 }); }
          default: throw new Error(`action stockage inconnue : ${a.action}`);
        }
      }),
    },

    // ---- Clip de timeline courant (couleur / drapeaux / propriétés) ----------
    {
      name: 'resolve_timeline_item',
      description: 'Plan vidéo SÉLECTIONNÉ dans la timeline (current video item). action: info | get_property(key) | '
        + 'set_property(key,value) | set_clip_color(color) | add_flag(color) | get_flags | add_version(name) | set_cdl(cdl).',
      risk: 'write',
      riskFor: READ(new Set(['info', 'get_property', 'get_flags'])),
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['info', 'get_property', 'set_property', 'set_clip_color', 'add_flag', 'get_flags', 'add_version', 'set_cdl'] }, key: { type: 'string' }, value: {}, color: { type: 'string' }, name: { type: 'string' }, cdl: { type: 'object' } },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { tl } = await curTimeline();
        const it = await tl.GetCurrentVideoItem();
        if (!it) throw new Error('aucun plan vidéo sous la tête de lecture');
        switch (a.action) {
          case 'info': return ok({ name: await it.GetName(), start: await it.GetStart(), end: await it.GetEnd(), duration: await it.GetDuration() });
          case 'get_property': return ok({ value: await it.GetProperty(String(a.key)) });
          case 'set_property': return ok({ set: await it.SetProperty(String(a.key), a.value) });
          case 'set_clip_color': return ok({ set: await it.SetClipColor(String(a.color)) });
          case 'add_flag': return ok({ added: await it.AddFlag(String(a.color || 'Blue')) });
          case 'get_flags': return ok({ flags: await it.GetFlagList() });
          case 'add_version': return ok({ added: await it.AddVersion(String(a.name || 'v'), 0) });
          case 'set_cdl': return ok({ set: await it.SetCDL(a.cdl || {}) });
          default: throw new Error(`action plan inconnue : ${a.action}`);
        }
      }),
    },

    // ---- Visionneuse / lecteur (« voir » l'image, naviguer) ------------------
    {
      name: 'resolve_viewer',
      description: 'Visionneuse / lecteur Resolve — « voir » l’image courante et déplacer la tête de lecture. '
        + 'action: get_timecode | set_timecode(timecode "HH:MM:SS:FF") | get_current_clip | grab_still(path?,format?). '
        + 'grab_still CAPTURE l’image sous la tête de lecture et l’exporte en fichier (PNG par défaut) → l’image '
        + 'est automatiquement JOINTE au résultat : tu la VOIS directement (le chemin du fichier est aussi renvoyé). '
        + 'Sert aussi à VÉRIFIER visuellement une compo Fusion après resolve_fusion. Pour avancer/reculer le lecteur, '
        + 'set_timecode. (La capture marche mieux depuis la page Color — bascule avec resolve_app switch_page color si besoin.)',
      risk: 'read',
      riskFor: READ(new Set(['get_timecode', 'get_current_clip', 'grab_still'])),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get_timecode', 'set_timecode', 'get_current_clip', 'grab_still'] },
          timecode: { type: 'string' }, path: { type: 'string' }, format: { type: 'string', enum: ['png', 'jpg', 'tif', 'dpx', 'exr'] },
        },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { proj, tl } = await curTimeline();
        switch (a.action) {
          case 'get_timecode': return ok({ timecode: await tl.GetCurrentTimecode() });
          case 'set_timecode': return ok({ set: await tl.SetCurrentTimecode(String(a.timecode)) });
          case 'get_current_clip': {
            const it = await tl.GetCurrentVideoItem();
            if (!it) return ok({ clip: null });
            return ok({ name: await it.GetName(), start: await it.GetStart(), end: await it.GetEnd(), duration: await it.GetDuration() });
          }
          case 'grab_still': {
            const still = await tl.GrabStill();
            if (!still) throw new Error('capture impossible (essaie depuis la page Color : resolve_app switch_page color)');
            const gallery = await proj.GetGallery();
            const album = await gallery.GetCurrentStillAlbum();
            const dir = a.path || path.join(os.tmpdir(), 'netsurush-stills');
            fs.mkdirSync(dir, { recursive: true });
            const fmt = String(a.format || 'png').toLowerCase();
            const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
            const exported = await album.ExportStills([still], dir, 'nr', fmt);
            // Resolve nomme le fichier lui-même (préfixe + index) → on retrouve le nouveau fichier le plus récent.
            const added = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
              .filter((/** @type {string} */ f) => !before.has(f) && f.toLowerCase().endsWith('.' + fmt))
              .map((/** @type {string} */ f) => path.join(dir, f));
            return ok({ exported: !!exported, file: added[0] || null, dir });
          }
          default: throw new Error(`action visionneuse inconnue : ${a.action}`);
        }
      }),
    },

    // ---- Fusion : comp du plan courant (page Fusion) --------------------------
    {
      name: 'resolve_fusion',
      description: 'Compos Fusion — construit/édite le graphe de nodes de la comp COURANTE. Prérequis : tête de '
        + 'lecture sur un plan puis page Fusion ouverte (resolve_app switch_page fusion). action: comp_info | '
        + 'list_tools (nodes existants) | add_tool(type,name?,x?,y?) — type = RegID Fusion exact (Background, '
        + 'TextPlus, Merge, Transform, Blur, ColorCorrector, Glow…) | set_input(tool,input,value) — règle un '
        + 'paramètre d’un node par son nom | connect(from,to,input?) — relie la sortie de `from` à l’entrée de '
        + '`to` (input omis = entrée principale ; Merge : Background/Foreground) | build_graph(nodes,connections) '
        + '— compo COMPLÈTE en un appel : nodes [{type,name?,x?,y?,inputs?}], connections [{from,to,input?}].',
      risk: 'write',
      riskFor: READ(new Set(['comp_info', 'list_tools'])),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['comp_info', 'list_tools', 'add_tool', 'set_input', 'connect', 'build_graph'] },
          type: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
          tool: { type: 'string' }, input: { type: 'string' }, value: {},
          from: { type: 'string' }, to: { type: 'string' },
          nodes: {
            type: 'array',
            items: { type: 'object', properties: { type: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, inputs: { type: 'object' } }, required: ['type'] },
          },
          connections: {
            type: 'array',
            items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, input: { type: 'string' } }, required: ['from', 'to'] },
          },
        },
        required: ['action'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { resolve } = await ctx();
        const fu = await resolve.Fusion();
        if (!fu) throw new Error('Fusion indisponible');
        const comp = await fu.GetCurrentComp();
        if (!comp) throw new Error('aucune comp Fusion ouverte (place la tête sur un plan puis resolve_app switch_page fusion)');
        // Handles Fusion tenus DANS ce handler (un seul op guarded) → pas purgés par le reset du pont.
        const prims = (/** @type {any} */ o) => {
          const out = {};
          for (const k of Object.keys(o || {})) { const v = o[k]; if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v; }
          return out;
        };
        const addTool = async (/** @type {any} */ n) => {
          const tool = await comp.AddTool(String(n.type), n.x ?? -32768, n.y ?? -32768);
          if (!tool) throw new Error(`AddTool a échoué : ${n.type} (RegID inconnu ?)`);
          if (n.name) await tool.SetAttrs({ TOOLS_Name: String(n.name) });
          const at = (await tool.GetAttrs()) || {};
          return { tool, name: String(n.name || at.TOOLS_Name || n.type) };
        };
        const connectTo = async (/** @type {any} */ from, /** @type {any} */ to, /** @type {any} */ input, /** @type {string} */ label) => {
          if (input) { await to.ConnectInput(String(input), from); return; }
          const inp = await to.FindMainInput(1);
          if (!inp) throw new Error(`entrée principale introuvable sur ${label}`);
          await inp.ConnectTo(from);
        };
        switch (a.action) {
          case 'comp_info': return ok({ attrs: prims(await comp.GetAttrs()) });
          case 'list_tools': {
            const dict = (await comp.GetToolList(false)) || {};
            const tools = [];
            for (const k of Object.keys(dict)) {
              const at = (await dict[k].GetAttrs()) || {};
              tools.push({ name: at.TOOLS_Name, type: at.TOOLS_RegID });
            }
            return ok({ tools });
          }
          case 'add_tool': { const { name } = await addTool(a); return ok({ added: name, type: a.type }); }
          case 'set_input': {
            const tool = await comp.FindTool(String(a.tool));
            if (!tool) throw new Error(`node introuvable : ${a.tool}`);
            await tool.SetInput(String(a.input), a.value);
            return ok({ set: `${a.tool}.${a.input}` });
          }
          case 'connect': {
            const from = await comp.FindTool(String(a.from));
            const to = await comp.FindTool(String(a.to));
            if (!from) throw new Error(`node introuvable : ${a.from}`);
            if (!to) throw new Error(`node introuvable : ${a.to}`);
            await connectTo(from, to, a.input, String(a.to));
            return ok({ connected: `${a.from} → ${a.to}${a.input ? ` (${a.input})` : ''}` });
          }
          case 'build_graph': {
            // Lock = pas de dialogues Fusion pendant la construction ; Unlock garanti même sur erreur.
            try { await comp.Lock(); } catch { /* Lock absent → tant pis */ }
            try {
              const byName = new Map();
              const created = [];
              for (const n of (a.nodes || [])) {
                const { tool, name } = await addTool(n);
                byName.set(name, tool);
                for (const [k, v] of Object.entries(n.inputs || {})) await tool.SetInput(k, v);
                created.push(name);
              }
              let connected = 0;
              for (const c of (a.connections || [])) {
                const from = byName.get(String(c.from)) || await comp.FindTool(String(c.from));
                const to = byName.get(String(c.to)) || await comp.FindTool(String(c.to));
                if (!from || !to) throw new Error(`connexion impossible : ${c.from} → ${c.to} (node introuvable)`);
                await connectTo(from, to, c.input, String(c.to));
                connected++;
              }
              return ok({ nodes: created, connections: connected });
            } finally {
              try { await comp.Unlock(); } catch { /* noop */ }
            }
          }
          default: throw new Error(`action fusion inconnue : ${a.action}`);
        }
      }),
    },

    // ---- Échappatoire : API Resolve COMPLÈTE (n'importe quelle méthode) ------
    {
      name: 'resolve_call',
      description: 'ÉCHAPPATOIRE — appelle DIRECTEMENT n’importe quelle méthode de l’API de scripting Resolve '
        + '(catalogue COMPLET, ~300+ méthodes) quand aucun outil dédié ne couvre le besoin → mainmise totale. '
        + 'root = objet de départ : resolve | project_manager | project | media_pool | media_storage | timeline | '
        + 'timeline_item (plan sous la tête) | gallery | fusion. chain = suite d’étapes enchaînées sur le résultat '
        + 'précédent : {method, args?} = appel de méthode, {index:n} = prend le n-ième élément (base 0) d’une '
        + 'LISTE renvoyée par l’étape d’avant (GetClipList, GetItemListInTrack…) ; le DERNIER résultat est renvoyé. '
        + 'Noms de méthodes EXACTS (sensibles à la casse — cf. doc Resolve / gist mhadifilms). Mets readOnly:true '
        + 'si la chaîne ne fait que LIRE (Get*) pour éviter une confirmation. Préfère les outils typés '
        + '(resolve_timeline, resolve_fusion, build_timeline, resolve_render…) pour le courant et le '
        + 'frame-accurate ; resolve_call = pour TOUT le reste.',
      risk: 'write',
      riskFor: (/** @type {any} */ a) => (a && a.readOnly ? 'read' : 'write'),
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', enum: ['resolve', 'project_manager', 'project', 'media_pool', 'media_storage', 'timeline', 'timeline_item', 'gallery', 'fusion'] },
          chain: {
            type: 'array',
            items: { type: 'object', properties: { method: { type: 'string' }, args: { type: 'array' }, index: { type: 'number' } } },
            description: 'Ex. [{"method":"GetCurrentTimeline"},{"method":"GetItemListInTrack","args":["video",1]},{"index":0},{"method":"GetName"}]',
          },
          readOnly: { type: 'boolean', description: 'true = la chaîne ne fait que lire (pas de confirmation)' },
        },
        required: ['root', 'chain'],
      },
      handler: g(async (/** @type {any} */ a) => {
        const { resolve, pm, proj } = await ctx();
        let obj;
        switch (a.root) {
          case 'resolve': obj = resolve; break;
          case 'project_manager': obj = pm; break;
          case 'project': obj = proj; break;
          case 'media_pool': obj = proj && await proj.GetMediaPool(); break;
          case 'media_storage': obj = await resolve.GetMediaStorage(); break;
          case 'timeline': obj = proj && await proj.GetCurrentTimeline(); break;
          case 'timeline_item': { const tl = proj && await proj.GetCurrentTimeline(); obj = tl && await tl.GetCurrentVideoItem(); break; }
          case 'gallery': obj = proj && await proj.GetGallery(); break;
          case 'fusion': obj = await resolve.Fusion(); break;
          default: throw new Error(`root inconnu : ${a.root}`);
        }
        if (!obj) throw new Error(`objet racine indisponible : ${a.root} (projet / timeline ouverts ?)`);
        const trace = [];
        for (const step of (a.chain || [])) {
          if (step && typeof step.index === 'number') {
            if (!Array.isArray(obj)) throw new Error(`{index:${step.index}} : le résultat précédent n'est pas une liste (${trace.length ? trace[trace.length - 1] : a.root})`);
            obj = obj[step.index | 0];
            if (obj == null) throw new Error(`{index:${step.index}} hors limites (liste de ${trace.length ? 'l’étape ' + trace[trace.length - 1] : a.root})`);
            trace.push(`[${step.index | 0}]`);
            continue;
          }
          const m = step && step.method;
          if (!m || typeof obj[m] !== 'function') throw new Error(`méthode introuvable : ${m} (sur ${trace.length ? trace[trace.length - 1] : a.root})`);
          obj = await obj[m](...(Array.isArray(step.args) ? step.args : []));
          trace.push(m);
        }
        // Les handles proxy ne se sérialisent pas en JSON → on ne renvoie que les valeurs primitives ;
        // sinon un repère (l'agent ré-enchaîne via une nouvelle chaîne partant de la même racine).
        const isPrim = (/** @type {any} */ v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
        const ser = isPrim(obj) || (Array.isArray(obj) && obj.every(isPrim));
        const result = ser ? obj : (Array.isArray(obj) ? `[${obj.length} objets Resolve]` : '[objet Resolve — ré-enchaîne pour lire ses propriétés]');
        return ok({ chain: trace, result, isObject: !ser });
      }),
    },
  ];
}

module.exports = { createResolveTools };
