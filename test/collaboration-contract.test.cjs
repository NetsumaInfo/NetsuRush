// The collaboration stack is mostly checked by `tsc` and `cargo check`. What neither of them can
// see is the SHAPE of the feature: that its documentation and security pointers exist, that the
// native command surface exposes no escape hatch around the typed operations, that the surface
// registry stays the only thing that knows what a project contains, and that the copy exists in all
// six locales. Those are the invariants a refactor breaks silently.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sourceFiles(relativeDirectory, extension) {
  const directory = path.join(root, relativeDirectory);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => read(path.join(relativeDirectory, entry.name)))
    .join("\n");
}

test("the native command surface exposes no way around the typed operations", () => {
  const native = sourceFiles("src-tauri/src/collab", ".rs");
  const renderer = sourceFiles("src/lib/collab", ".ts");

  // A generic key-wrapping or peer-allowing command would let a renderer choose recipients and
  // peers, which is exactly what the roster and the envelopes exist to decide.
  assert.doesNotMatch(`${native}\n${renderer}`, /collab_key_wrap|collab_net_allow/);
  // Raw key material never crosses the boundary.
  assert.doesNotMatch(renderer, /projectKey|project_key/);
  // The deployment is pinned at build time and the runtime hint is only ever validated against it.
  assert.match(native, /NETSURUSH_CONVEX_URL/);
  assert.match(read("src-tauri/build.rs"), /NETSURUSH_CONVEX_URL/);
});

test("a project is bound to a surface, never to one module's own document type", () => {
  const service = read("src-tauri/src/collab/service.rs");
  const blobs = read("src-tauri/src/collab/blobs.rs");
  const client = read("src/lib/collab/client.ts");
  const surfaces = read("src/lib/collab/surfaces.ts");

  // The binding key is (surface, document): two modules may reuse the same local id.
  assert.match(service, /fn subject_key\(surface: &str, subject_id: &str\)/);
  assert.match(service, /fn normalize_surface/);
  // Which local media a project may import is answered per surface.
  assert.match(blobs, /fn subject_data\(surface: &str, subject_id: &str\)/);
  // The renderer bridge carries the surface and knows nothing about what is inside a document.
  assert.match(client, /surface: string/);
  // No module type reaches the bridge: a projection is generic, its meaning belongs to the surface.
  assert.doesNotMatch(client, /from "@\/components\//);
  assert.match(client, /nativeProjection<T>/);
  // Registration is the single entry point a new module uses.
  assert.match(surfaces, /export function registerCollabSurface/);
  // The Convex row keeps the label in clear so an invitation can name what it invites to.
  assert.match(read("convex/schema.ts"), /surface: v\.optional\(v\.string\(\)\)/);
  assert.match(read("convex/projects.ts"), /export function normalizeSurface/);
});

test("the account panel and the notifications go through the registry, not through a module", () => {
  const panel = read("src/components/settings/SharingSettings.tsx");
  const notifications = read("src/components/collab/CollaborationNotifications.tsx");
  const dialog = read("src/components/collab/CollaborationDialog.tsx");

  assert.match(panel, /from "@\/lib\/collab\/surfaces"/);
  assert.doesNotMatch(panel, /components\/(reference|notebook|rushes|collections)\//);
  assert.doesNotMatch(notifications, /components\/(reference|notebook|rushes|collections)\//);
  // The shared dialog takes what it needs as props; the host module owns the publication.
  assert.match(dialog, /onShare: \(\) => Promise<\{ projectId: string \}>/);
  assert.doesNotMatch(dialog, /components\/(reference|notebook|rushes|collections)\//);
});

test("the device tombstone and the revocation path stay discoverable", () => {
  assert.match(read("SECURITY.md"), /native collaboration service/i);
  assert.match(read("AGENTS.md"), /docs\/collab\.md/);
  assert.match(read("docs/collab.md"), /Rust `CollabService` \+ Loro \+ SQLite/);
  assert.match(read("docs/distribution.md"), /VITE_CONVEX_URL/);
  assert.match(read("convex/schema.ts"), /revokedDevices/);
  assert.match(read("convex/devices.ts"), /revoked/i);
});

test("all six locales expose the collaboration copy", () => {
  for (const locale of ["fr", "en", "de", "es", "ja", "zh"]) {
    const collab = JSON.parse(read(`src/locales/${locale}/collab.json`));
    for (const section of ["device", "friends", "invites", "projects", "activity", "dialog", "panel"]) {
      assert.ok(collab[section], `${locale} collab.${section} is missing`);
    }
    const settings = JSON.parse(read(`src/locales/${locale}/settings.json`));
    assert.ok(settings.tab.account.sharing, `${locale} settings.tab.account.sharing is missing`);
  }
});

test("the reference board is registered as a surface and drives its own publication", () => {
  const surface = read("src/components/reference/collabSurface.ts");
  const dialog = read("src/components/reference/BoardCollaborationDialog.tsx");
  const bridge = read("src/components/reference/useCollabBridge.ts");
  const app = read("src/App.tsx");

  // Une seule déclaration, et elle est chargée au boot : les Paramètres doivent pouvoir nommer un
  // board partagé même si l'onglet Référence n'a jamais été ouvert.
  assert.match(surface, /registerCollabSurface\(\{/);
  assert.match(surface, /id: BOARD_SURFACE/);
  assert.match(app, /import "@\/components\/reference\/collabSurface"/);

  // Le board possède sa publication : soigner ses médias, entrer dans la bibliothèque, lier le
  // projet à la scène — et tout défaire quand la publication échoue.
  assert.match(dialog, /prepareShareMedia/);
  assert.match(dialog, /adoptIntoLibrary/);
  assert.match(dialog, /bindCollaboration/);
  assert.match(dialog, /abortAdoption/);
  assert.match(dialog, /surface: BOARD_SURFACE/);

  // Un lot dont le projet n'est plus celui du board est ABANDONNÉ : le diff produirait sinon la
  // suppression du document entier en quittant un board partagé.
  assert.match(bridge, /state\.collabProjectId !== projectId/);
});

test("a shared media never reaches the core as if it were a file", () => {
  for (const relative of [
    "src/components/reference/boardRender.ts",
    "src/components/reference/palette.ts",
    "src/components/reference/boardUpscale.ts",
    "src/components/reference/Inspector.tsx",
  ]) {
    assert.match(read(relative), /isCollabRef|isCoreFileRef/, `${relative} misses the guard`);
  }
  // La scène collaborative ne garde aucun item : sa liste de localisateurs est la SEULE trace des
  // fichiers locaux qu'elle affiche, et le ménage du magasin d'assets doit la lire.
  assert.match(read("core/reference.js"), /Array\.isArray\(scene && scene\.media\)/);
});
