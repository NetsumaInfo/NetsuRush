// Le service de fichiers média est le chemin le plus chaud du core (une grille joue jusqu'à ~24
// <video> qui demandent chacune leurs plages d'octets). Il est passé en I/O asynchrone : ces tests
// figent le contrat HTTP observé par la WebView2 (Range, ETag, HEAD, 404) pour que le passage en
// asynchrone — et tout changement ultérieur — ne le casse pas en silence.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { serveFile } = require("../core/media-server.js");

const BODY = "0123456789abcdefghij"; // 20 octets

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-media-"));
  const file = path.join(dir, "clip.mp4");
  fs.writeFileSync(file, BODY);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    serveFile(req, res, u.searchParams.get("p"));
  });
  return { dir, file, server };
}

/** Requête HTTP → { status, headers, body }. */
function request(port, target, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: target, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const { dir, file, server } = fixture();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const url = (p) => `/media?p=${encodeURIComponent(p)}`;
  try {
    await run({ port, file, url });
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("sert le fichier entier avec sa taille et le type MIME de l'extension", async () => {
  await withServer(async ({ port, file, url }) => {
    const res = await request(port, url(file));
    assert.equal(res.status, 200);
    assert.equal(res.body, BODY);
    assert.equal(res.headers["content-length"], String(BODY.length));
    assert.equal(res.headers["content-type"], "video/mp4");
    assert.equal(res.headers["accept-ranges"], "bytes");
  });
});

test("sert une plage d'octets en 206 avec le Content-Range exact", async () => {
  await withServer(async ({ port, file, url }) => {
    const res = await request(port, url(file), { headers: { Range: "bytes=5-9" } });
    assert.equal(res.status, 206);
    assert.equal(res.body, "56789");
    assert.equal(res.headers["content-range"], `bytes 5-9/${BODY.length}`);
    assert.equal(res.headers["content-length"], "5");
  });
});

test("une plage ouverte va jusqu'à la fin du fichier", async () => {
  await withServer(async ({ port, file, url }) => {
    const res = await request(port, url(file), { headers: { Range: "bytes=15-" } });
    assert.equal(res.status, 206);
    assert.equal(res.body, "fghij");
    assert.equal(res.headers["content-range"], `bytes 15-19/${BODY.length}`);
  });
});

test("une plage hors fichier répond 416", async () => {
  await withServer(async ({ port, file, url }) => {
    const res = await request(port, url(file), { headers: { Range: "bytes=99-120" } });
    assert.equal(res.status, 416);
    assert.equal(res.headers["content-range"], `bytes */${BODY.length}`);
  });
});

test("l'ETag renvoie 304 sans corps au re-montage d'une carte", async () => {
  await withServer(async ({ port, file, url }) => {
    const first = await request(port, url(file));
    const etag = first.headers.etag;
    assert.ok(etag, "un ETag doit être posé, sinon le webview re-décode à chaque re-montage");
    const second = await request(port, url(file), { headers: { "If-None-Match": etag } });
    assert.equal(second.status, 304);
    assert.equal(second.body, "");
  });
});

test("HEAD renvoie les en-têtes sans corps", async () => {
  await withServer(async ({ port, file, url }) => {
    const res = await request(port, url(file), { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.body, "");
    assert.equal(res.headers["content-length"], String(BODY.length));
  });
});

test("fichier absent → 404, dossier → 404, chemin vide ou à octet nul → 400", async () => {
  await withServer(async ({ port, file, url }) => {
    assert.equal((await request(port, url(file + ".missing"))).status, 404);
    assert.equal((await request(port, url(path.dirname(file)))).status, 404);
    assert.equal((await request(port, "/media?p=")).status, 400);
    assert.equal((await request(port, url("clip\0.mp4"))).status, 400);
  });
});

test("une rafale de requêtes concurrentes est servie intégralement", async () => {
  await withServer(async ({ port, file, url }) => {
    const results = await Promise.all(
      Array.from({ length: BODY.length }, (_, i) =>
        request(port, url(file), { headers: { Range: `bytes=${i}-${i}` } })),
    );
    results.forEach((res, i) => {
      assert.equal(res.status, 206);
      assert.equal(res.body, BODY[i]);
    });
  });
});
