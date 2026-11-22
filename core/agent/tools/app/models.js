// @ts-check
// Model manager: the AI weights and runtimes behind search, detection, upscale, interpolation, depth
// and matting. Nothing is bundled; each model is downloaded on demand and can be deleted at any time.

const { WAIT_PARAM } = require('./domain');

/** @param {any} s */
const lower = (s) => String(s || '').toLowerCase();

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_models',
  summary: 'AI model manager. Use list to find the exact model id a processing, detection or search action asks for, '
    + 'and to see whether it is installed before starting a job that needs it. Downloads are large (hundreds of MB to several GB).',
  actions: {
    list: {
      risk: 'read',
      usage: 'list(query?, installedOnly?, limit?) — models [{id, installed, sizeBytes?, partial?, downloading?, progress?, available?}]; '
        + 'query filters the id (e.g. "rife", "depth", "esrgan"); partial = interrupted install',
      channel: 'models:list',
      map: (r, a) => {
        let models = Array.isArray(r && r.models) ? r.models : [];
        if (a.query) models = models.filter((m) => lower(m.id).includes(lower(a.query)));
        if (a.installedOnly) models = models.filter((m) => m.installed);
        const total = models.length;
        const limit = Number(a.limit) > 0 ? Number(a.limit) : 80;
        const slim = models.slice(0, limit).map((m) => ({
          id: m.id, installed: !!m.installed,
          ...(m.sizeBytes ? { sizeBytes: m.sizeBytes } : {}),
          ...(m.partial ? { partial: true } : {}),
          ...(m.downloading ? { downloading: true, progress: m.progress } : {}),
          ...(m.available === false ? { available: false } : {}),
        }));
        return { total, models: slim, ...(total > limit ? { note: `Showing ${limit} of ${total}; pass query or limit.` } : {}) };
      },
    },
    disk_usage: {
      risk: 'read',
      usage: 'disk_usage() — bytes used by installed models, total and per task',
      channel: 'models:diskUsage',
    },
    gpu: {
      risk: 'read',
      usage: 'gpu() — the NVIDIA GPU {name, totalMB, freeMB}, or null; compare freeMB with what a heavy job needs',
      channel: 'models:gpu',
      map: (r) => (r ? { gpu: r } : { gpu: null, note: 'No NVIDIA GPU detected (nvidia-smi unavailable).' }),
    },
    download: {
      risk: 'write', long: true,
      usage: 'download(id, replace?) — download and install a model. replace:true accepts uninstalling an exclusive peer that shares the same Python package '
        + '(otherwise a conflict {family, blockedBy} is returned and nothing changes). Cancel with the cancel action.',
      channel: 'models:download', args: (a) => [a.id, a.replace === true],
    },
    cancel: {
      risk: 'write',
      usage: 'cancel(id) — abort a running download of that model',
      channel: 'models:cancel', args: (a) => [a.id],
    },
    import: {
      risk: 'write',
      usage: 'import(id, source) — copy a manually obtained weight file (absolute path) into place; only for models that cannot be downloaded (e.g. AutoShot, RTX SDK DLLs)',
      channel: 'models:import', args: (a) => [a.id, a.source],
    },
    delete: {
      risk: 'destructive',
      usage: 'delete(id) — uninstall a model and free its disk space (it must be downloaded again to be used)',
      channel: 'models:delete', args: (a) => [a.id],
    },
  },
  params: {
    id: { type: 'string', description: 'Model id, as returned by list' },
    query: { type: 'string', description: 'Case-insensitive filter on the model id' },
    installedOnly: { type: 'boolean' },
    limit: { type: 'number' },
    replace: { type: 'boolean', description: 'download: allow replacing an installed exclusive peer' },
    source: { type: 'string', description: 'import: absolute path of the weight file' },
    ...WAIT_PARAM,
  },
};
