const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'src', 'lib', 'coreClient.ts'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src', 'lib', 'bridge.ts'), 'utf8');

test('renderer bridge reveals an exact local file in its directory', () => {
  assert.match(client, /revealItemInDir/);
  assert.match(client, /revealPath:\s*\(p\)\s*=>\s*revealPath\(p\)/);
  assert.match(bridge, /revealPath\(path:\s*string\):\s*Promise<boolean>/);
  assert.match(bridge, /revealPath:\s*async\s*\(\)\s*=>\s*false/);
});
