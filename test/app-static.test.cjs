// /app sert le renderer buildé au panneau CEP (des centaines de chunks d'affilée). Le service est
// passé en I/O asynchrone : ces tests figent le contrat (repli SPA, cache, anti-traversal) pour que
// le passage en asynchrone — et tout changement ultérieur — ne le casse pas en silence.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// La racine servie est `NR_RESOURCE_DIR/dist`. `distRoot()` la mémorise au 1er appel → poser l'env
// AVANT le require. Le fichier « secret » vit HORS de dist : seul un path traversal l'atteindrait.
const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-resources-"));
const dist = path.join(resourceDir, "dist");
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
fs.writeFileSync(path.join(dist, "assets", "main-abc123.js"), "export const x=1;");
fs.writeFileSync(path.join(resourceDir, "secret-outside.txt"), "not reachable via traversal");
process.env.NR_RESOURCE_DIR = resourceDir;

const { serveApp, appAvailable } = require("../core/appstatic.js");

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (!serveApp(req, res, u)) res.writeHead(404).end("no");
});

function request(port, target, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let port = 0;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(resourceDir, { recursive: true, force: true });
});

test("un build stagé est annoncé comme servable", () => {
  assert.equal(appAvailable(), true);
});

test("une requête hors /app n'est pas traitée par ce handler", async () => {
  assert.equal((await request(port, "/healthz")).status, 404);
});

test("/app redirige vers /app/ pour que les URLs relatives se résolvent", async () => {
  const res = await request(port, "/app");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/app/");
});

test("/app/ sert index.html, jamais caché", async () => {
  const res = await request(port, "/app/");
  assert.equal(res.status, 200);
  assert.match(res.body, /<title>app<\/title>/);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache");
});

test("un asset fingerprinté est servi avec un cache long", async () => {
  const res = await request(port, "/app/assets/main-abc123.js");
  assert.equal(res.status, 200);
  assert.equal(res.body, "export const x=1;");
  assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(res.headers["cache-control"], "public, max-age=86400");
});

test("une route inconnue retombe sur index.html (routage côté client)", async () => {
  const res = await request(port, "/app/collections/42");
  assert.equal(res.status, 200);
  assert.match(res.body, /<title>app<\/title>/);
});

test("le path traversal est refusé, pas replié sur index.html", async () => {
  const res = await request(port, "/app/..%2f..%2fsecret-outside.txt");
  assert.equal(res.status, 403);
});

test("HEAD renvoie les en-têtes sans corps", async () => {
  const res = await request(port, "/app/assets/main-abc123.js", "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.body, "");
  assert.equal(res.headers["content-length"], "17");
});

test("une rafale de requêtes d'assets est servie intégralement", async () => {
  const results = await Promise.all(
    Array.from({ length: 40 }, () => request(port, "/app/assets/main-abc123.js")),
  );
  for (const res of results) {
    assert.equal(res.status, 200);
    assert.equal(res.body, "export const x=1;");
  }
});
