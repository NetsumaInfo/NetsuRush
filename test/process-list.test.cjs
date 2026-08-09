const test = require("node:test");
const assert = require("node:assert/strict");

const { createProcessList, parseTasklistImages } = require("../core/processList.js");

const SAMPLE = [
  '"System Idle Process","0","Services","0","8 K"',
  '"Resolve.exe","12345","Console","1","3 456 789 K"',
  '"Adobe Premiere Pro.exe","2222","Console","1","1 234 K"',
  "",
].join("\r\n");

/** Faux execFile qui compte les spawns et rend une sortie tasklist figée. */
function fakeExec({ output = SAMPLE, err = null } = {}) {
  const calls = [];
  const execFileFn = (file, args, opts, cb) => {
    calls.push({ file, args });
    setImmediate(() => cb(err, output, ""));
  };
  return { execFileFn, calls };
}

test("parseTasklistImages ne garde que la 1re colonne CSV, en minuscules", () => {
  const images = parseTasklistImages(SAMPLE);
  assert.ok(images.has("resolve.exe"));
  assert.ok(images.has("adobe premiere pro.exe"));
  assert.equal(images.has("12345"), false);
});

test("un seul tasklist sert plusieurs images interrogées en parallèle", async () => {
  const { execFileFn, calls } = fakeExec();
  const list = createProcessList({ execFileFn });
  const [resolve, premiere, afterfx] = await Promise.all([
    list.isImageRunning("Resolve.exe"),
    list.isImageRunning("Adobe Premiere Pro.exe"),
    list.isImageRunning("AfterFX.exe"),
  ]);
  assert.equal(resolve, true);
  assert.equal(premiere, true);
  assert.equal(afterfx, false);
  assert.equal(calls.length, 1, "les appels concurrents partagent le même vol");
  assert.deepEqual(calls[0].args, ["/nh", "/fo", "csv"]);
});

test("le cache absorbe les sondes rapprochées puis expire", async () => {
  const { execFileFn, calls } = fakeExec();
  const list = createProcessList({ execFileFn, ttlMs: 30 });
  await list.isImageRunning("Resolve.exe");
  await list.isImageRunning("Resolve.exe");
  assert.equal(calls.length, 1);
  await new Promise((r) => setTimeout(r, 40));
  await list.isImageRunning("Resolve.exe");
  assert.equal(calls.length, 2, "au-delà du TTL la sonde relit l'état réel");
});

test("invalidate force une relecture (après un lancement ou un taskkill)", async () => {
  const { execFileFn, calls } = fakeExec();
  const list = createProcessList({ execFileFn, ttlMs: 60_000 });
  await list.isImageRunning("Resolve.exe");
  list.invalidate();
  await list.isImageRunning("Resolve.exe");
  assert.equal(calls.length, 2);
});

test("tasklist absent ou en échec : aucune image connue, jamais de rejet", async () => {
  const { execFileFn } = fakeExec({ err: new Error("ENOENT"), output: "" });
  const list = createProcessList({ execFileFn });
  assert.equal(await list.isImageRunning("Resolve.exe"), false);
});

test("un nom d'image vide ne déclenche aucun spawn", async () => {
  const { execFileFn, calls } = fakeExec();
  const list = createProcessList({ execFileFn });
  assert.equal(await list.isImageRunning(""), false);
  assert.equal(calls.length, 0);
});
