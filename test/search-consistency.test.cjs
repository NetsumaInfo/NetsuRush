const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('only the latest result request may write the grid', () => {
  const store = read('src/store/search.ts');
  for (const action of ['runSearch: async', 'searchByIndexedFace: async', 'runFaceSearch: async']) {
    const body = store.slice(store.indexOf(action), store.indexOf(action) + 4000);
    assert.match(body, /const ticket = takeTicket\(\)/, `${action} must take a ticket`);
    assert.match(body, /if \(!isCurrent\(ticket\)\) return;/, `${action} must drop a stale response`);
  }
  // A scope change invalidates whatever is still in flight, and clears the query with the hits.
  assert.match(store, /takeTicket\(\);\s*set\(\{ searchScope, searchHits: \[\], searchQuery: ""/);
  assert.match(store, /takeTicket\(\);\s*set\(\{ selectedProjects, searchHits: \[\], searchQuery: ""/);
});

test('duplicates and groups refine what is shown and never hide the results', () => {
  const store = read('src/store/search.ts');
  const analyze = store.slice(store.indexOf('async function analyzeResults'), store.indexOf('const takeTicket'));
  assert.match(analyze, /h\.score >= st\.scoreThreshold/);
  assert.doesNotMatch(analyze, /searchError/, 'an analysis failure is a notice over the flat view');
  assert.match(analyze, /resultView: "flat", searchNotice/);
});

test('selection, counter and export follow the view on screen', () => {
  const results = read('src/components/search/SearchResults.tsx');
  assert.match(results, /const viewHits = useMemo/);
  assert.match(results, /new Set\(viewHits\.map\(hitKey\)\)/, '"select all" takes every shot the counter announces');
  assert.doesNotMatch(results, /resultView === "flat" && \(\s*<Tooltip>\s*<TooltipTrigger render=\{<button/);
  assert.match(results, /card\(h, groupOffsets\[gi\] \+ i\)/, 'grouped views need unique playback indices');
});
