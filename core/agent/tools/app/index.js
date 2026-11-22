// @ts-check
// App-wide tools: one compound tool per NetsuRush domain, each action mapped onto an existing rpc
// channel. Together with netsurush.js (derush shortcuts) and resolve.js (Resolve catalogue) they give
// an agent the same reach as the UI.

const { buildDomainTool } = require('./domain');

const DOMAINS = [
  require('./library'),
  require('./collections'),
  require('./search'),
  require('./characters'),
  require('./media'),
  require('./export'),
  require('./process'),
  require('./models'),
  require('./host'),
  require('./notebook'),
  require('./system'),
  require('./jobs'),
  require('./rpc'),
  require('./agents'),
];

/**
 * @param {import('./domain').ActionCtx} ctx
 * @returns {import('../registry').ToolDef[]}
 */
function createAppTools(ctx) {
  return DOMAINS.map((def) => buildDomainTool(def, ctx));
}

module.exports = { createAppTools, DOMAINS };
