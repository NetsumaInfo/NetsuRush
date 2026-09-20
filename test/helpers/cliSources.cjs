// Reads the install commands out of the renderer's catalogue so the guard test
// checks the real list rather than a copy of it. A duplicated list would agree
// with itself forever while the shipped one drifted.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "..", "..", "src", "lib", "agentCatalog.ts"), "utf8");

const CLI_SOURCES = {};
const block = source.slice(source.indexOf("export const CLI_SOURCES"));
const entry = /(\w+):\s*\{[^}]*?install:\s*"([^"]+)"/gs;
for (const match of block.matchAll(entry)) {
  CLI_SOURCES[match[1]] = { install: match[2] };
}

if (Object.keys(CLI_SOURCES).length === 0) {
  throw new Error("no install command found in agentCatalog.ts — the shape changed");
}

module.exports = { CLI_SOURCES };
