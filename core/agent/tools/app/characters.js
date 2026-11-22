// @ts-check
// Characters: named identities (an anime character or a real person) built from face samples, used to
// find every shot where that person appears (python/nrsearch/characters.py).

const { WAIT_PARAM } = require('./domain');

/** @type {import('./domain').DomainDef} */
module.exports = {
  name: 'netsu_characters',
  summary: 'NetsuRush character roster: a character is a named face/character identity (name, notes, tags, colour, '
    + 'face samples) used to find the shots where a person appears. Workflow: create a character, add face samples '
    + '(from a reference image or an indexed shot), run label_index to label every indexed face, then use '
    + 'search/shots to list the shots. Needs the face index (netsu_search face_index). A face reference ("ref") is '
    + '{path, bbox?, domain?} (image file) or {file_path, scene_index, face_index?} (indexed shot).',
  actions: {
    list: { risk: 'read', usage: 'list(filePaths?) — characters {id, name, notes, tags, color, samples:{anime,real}, total}', channel: 'char:list', args: (a) => [{ filePaths: a.filePaths }] },
    samples: { risk: 'read', usage: 'samples(charId) — face samples of a character', channel: 'char:samples', args: (a) => [a.charId] },
    identify: {
      risk: 'read',
      usage: 'identify(refs[], minScore?) — best roster match per reference face {matches:[{index, char_id, name, score}|null]}',
      channel: 'char:identify', args: (a) => [{ refs: a.refs || [], minScore: a.minScore }],
    },
    search: {
      risk: 'read',
      usage: 'search(charId, topK?, minScore?, filePaths?) — shots (hits {file_path, start_frame, end_frame, start_sec, end_sec, score}) where the character appears',
      channel: 'char:search', args: (a) => [{ charId: a.charId, topK: a.topK, minScore: a.minScore, filePaths: a.filePaths }],
    },
    shots: {
      risk: 'read',
      usage: 'shots(charId, topK?, filePaths?) — all labelled shots of a character (default topK 200)',
      channel: 'char:shots', args: (a) => [{ charId: a.charId, topK: a.topK, filePaths: a.filePaths }],
    },
    duplicates: {
      risk: 'read',
      usage: 'duplicates(minScore?) — characters that look like the same identity (merge candidates)',
      channel: 'char:duplicates', args: (a) => [{ minScore: a.minScore }],
    },
    create: {
      risk: 'write',
      usage: 'create(name, notes?, tags?, color?) — new empty character; returns its id',
      channel: 'char:create', args: (a) => [{ name: a.name, notes: a.notes, tags: a.tags, color: a.color }],
    },
    update: {
      risk: 'write',
      usage: 'update(charId, name?, notes?, tags?, color?) — edit a character',
      channel: 'char:update', args: (a) => [{ id: a.charId, name: a.name, notes: a.notes, tags: a.tags, color: a.color }],
    },
    add_sample: {
      risk: 'write',
      usage: 'add_sample(charId, ref) — add a face sample from an image {path, bbox?} or an indexed shot {file_path, scene_index, face_index?}',
      channel: 'char:addSample', args: (a) => [{ charId: a.charId, ...(a.ref || {}) }],
    },
    remove_sample: { risk: 'write', usage: 'remove_sample(sampleId) — remove one face sample', channel: 'char:removeSample', args: (a) => [a.sampleId] },
    label_index: {
      risk: 'write', long: true,
      usage: 'label_index(minScore?) — label EVERY indexed face against the roster (recomputes all labels); slow on big indexes',
      channel: 'char:labelIndex', args: (a) => [{ minScore: a.minScore }],
    },
    merge: {
      risk: 'destructive',
      usage: 'merge(sourceId, targetId) — merge the source character into the target; the source is deleted',
      channel: 'char:merge', args: (a) => [{ sourceId: a.sourceId, targetId: a.targetId }],
    },
    delete: { risk: 'destructive', usage: 'delete(charId) — delete a character, its samples and labels', channel: 'char:delete', args: (a) => [a.charId] },
  },
  params: {
    charId: { type: 'number', description: 'Character id (integer from list)' },
    sampleId: { type: 'number', description: 'Sample id (from samples)' },
    sourceId: { type: 'number' },
    targetId: { type: 'number' },
    name: { type: 'string' },
    notes: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    color: { type: 'string' },
    ref: {
      type: 'object',
      description: 'Face reference: {path, bbox?:[x,y,w,h], domain?:"anime"|"real"} or {file_path, scene_index, face_index?}',
      properties: {
        path: { type: 'string' }, bbox: { type: 'array', items: { type: 'number' } }, domain: { type: 'string', enum: ['anime', 'real'] },
        file_path: { type: 'string' }, scene_index: { type: 'number' }, face_index: { type: 'number' },
      },
    },
    refs: { type: 'array', items: { type: 'object' }, description: 'Face references (see ref)' },
    minScore: { type: 'number', description: 'Minimum similarity, 0-1' },
    topK: { type: 'number' },
    filePaths: { type: 'array', items: { type: 'string' }, description: 'Restrict to these source files' },
    ...WAIT_PARAM,
  },
};
