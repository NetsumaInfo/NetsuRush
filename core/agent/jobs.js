// @ts-check
// Background jobs for agent tool calls. An MCP client abandons a call after a minute or so, while
// indexing a folder, upscaling or archiving a collection takes far longer. A long action therefore
// starts here: if it settles within the wait window its result is returned inline, otherwise the
// caller gets a job id and polls `netsu_jobs`.
//
// Progress is not threaded through each module: the core already broadcasts it on `*:progress`-like
// channels for the UI, and `observe` keeps the last such payload on every job still running.

const DEFAULT_WAIT_MS = 20000;
const KEEP_FINISHED = 50;

function createJobs() {
  let seq = 0;
  /** @type {Map<string, any>} */
  const jobs = new Map();

  function prune() {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id);
  }

  /** @param {any} j */
  function view(j) {
    return {
      jobId: j.id, label: j.label, status: j.status,
      startedAt: j.startedAt, endedAt: j.endedAt || null,
      elapsedSeconds: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000),
      ...(j.progress !== undefined ? { progress: j.progress } : {}),
      ...(j.status === 'done' ? { result: j.result } : {}),
      ...(j.status === 'error' ? { error: j.error } : {}),
    };
  }

  /**
   * @param {string} label
   * @param {()=>Promise<any>} exec
   * @param {{ waitMs?:number, cancel?:()=>any }} [opts]
   */
  async function run(label, exec, opts = {}) {
    const id = `job-${Date.now().toString(36)}-${(seq += 1)}`;
    const job = { id, label, status: 'running', startedAt: Date.now(), cancel: opts.cancel, result: undefined, error: undefined, progress: undefined, endedAt: 0 };
    jobs.set(id, job);
    prune();
    const settled = Promise.resolve().then(exec).then(
      (result) => {
        if (job.status === 'running') {
          job.status = result && result.ok === false ? 'error' : 'done';
          job.result = result;
          if (job.status === 'error') job.error = result.error || 'failed';
        }
        job.endedAt = Date.now();
      },
      (e) => {
        if (job.status === 'running') { job.status = 'error'; job.error = String((e && e.message) || e); }
        job.endedAt = Date.now();
      },
    );
    job.settled = settled;
    const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
    let timer;
    await Promise.race([settled, new Promise((r) => { timer = setTimeout(r, waitMs); })]);
    clearTimeout(timer);
    if (job.status === 'done') return job.result;
    if (job.status === 'error') return job.result && typeof job.result === 'object' ? job.result : { ok: false, error: job.error };
    return { ok: true, background: true, ...view(job), note: 'Still running. Poll netsu_jobs action=status (or wait) with this jobId.' };
  }

  /** @param {string} id */
  function status(id) {
    const j = jobs.get(String(id));
    return j ? { ok: true, ...view(j) } : { ok: false, error: `unknown job: ${id}` };
  }

  /** @param {string} id @param {number} [seconds] */
  async function wait(id, seconds) {
    const j = jobs.get(String(id));
    if (!j) return { ok: false, error: `unknown job: ${id}` };
    const ms = Math.max(0, Math.min(Number(seconds) || 30, 50)) * 1000;
    let timer;
    await Promise.race([j.settled, new Promise((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
    return status(id);
  }

  function list() {
    return { ok: true, jobs: [...jobs.values()].reverse().map((j) => { const v = view(j); delete v.result; return v; }) };
  }

  /** @param {string} id */
  async function cancel(id) {
    const j = jobs.get(String(id));
    if (!j) return { ok: false, error: `unknown job: ${id}` };
    if (j.status !== 'running') return { ok: false, error: `job already ${j.status}` };
    if (!j.cancel) return { ok: false, error: 'this job cannot be cancelled' };
    try { await j.cancel(); } catch (e) { return { ok: false, error: String((e && /** @type {any} */ (e).message) || e) }; }
    j.status = 'cancelled';
    j.endedAt = Date.now();
    return { ok: true, ...view(j) };
  }

  /// Keeps the latest progress payload on the running jobs. Several jobs at once cannot be told
  /// apart from a broadcast, so each gets the latest one — an approximation the UI shares.
  /** @param {string} channel @param {any} payload */
  function observe(channel, payload) {
    if (!/progress/i.test(channel)) return;
    for (const j of jobs.values()) {
      if (j.status === 'running') j.progress = { channel, ...(payload && typeof payload === 'object' ? payload : { value: payload }) };
    }
  }

  return { run, status, wait, list, cancel, observe };
}

module.exports = { createJobs, DEFAULT_WAIT_MS };
