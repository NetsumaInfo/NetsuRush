const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const rpc = fs.readFileSync(path.join(root, 'core', 'rpc.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src', 'lib', 'bridge.ts'), 'utf8');
const thumb = fs.readFileSync(path.join(root, 'src', 'components', 'reference', 'SceneThumb.tsx'), 'utf8');

test('project preview is wired through every IPC surface', () => {
  assert.match(rpc, /"netsu:previewProject"/);
  assert.match(client, /previewProject:\s*\(srcPath\)\s*=>\s*call\("netsu:previewProject"/);
  assert.match(bridge, /previewProject\(srcPath:\s*string\):\s*Promise<NetsuImportResult>/);
  assert.match(bridge, /previewProject:\s*async\s*\(\)\s*=>/);
});

test('file projects reuse the board thumbnail renderer', () => {
  assert.match(thumb, /export const ProjectThumb/);
  assert.match(thumb, /previewProject\(path\)/);
  assert.match(thumb, /<BoardThumb items=/);
});
