// @ts-check
// Background jobs started by long netsu_* actions (indexing, exports, upscales, archives…).

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_jobs',
  summary: 'Background jobs started by long netsu_* actions. A long action that does not finish within its wait '
    + 'window returns {background:true, jobId}; follow it here.',
  actions: {
    list: { risk: 'read', usage: 'list() — recent jobs with status and progress', run: (_a, ctx) => ctx.jobs.list() },
    status: { risk: 'read', usage: 'status(jobId) — status, progress, and the result once done', run: (a, ctx) => ctx.jobs.status(a.jobId) },
    wait: { risk: 'read', usage: 'wait(jobId, seconds?) — block up to `seconds` (max 50) for the job to finish, then report', run: (a, ctx) => ctx.jobs.wait(a.jobId, a.seconds) },
    cancel: { risk: 'write', usage: 'cancel(jobId) — abort a running job when its action supports it', run: (a, ctx) => ctx.jobs.cancel(a.jobId) },
  },
  params: {
    jobId: { type: 'string' },
    seconds: { type: 'number' },
  },
};
