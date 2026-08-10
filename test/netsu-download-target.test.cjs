const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const target = require('../core/netsu/downloadTarget');

test('project downloads are written directly into organized companion buckets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-download-target-'));
  const project = path.join(root, 'Board.netsu');
  fs.writeFileSync(project, 'project');

  const image = target.writeBuffer(project, 'image', 'Poster', Buffer.from('image bytes'), 'png');
  const video = target.writeBuffer(project, 'video', 'Clip', Buffer.from('video bytes'), 'mp4');

  assert.equal(path.dirname(image), path.join(root, 'Board.medias', 'images'));
  assert.equal(path.dirname(video), path.join(root, 'Board.medias', 'videos'));
  assert.equal(fs.readFileSync(image, 'utf8'), 'image bytes');
  assert.equal(fs.readFileSync(video, 'utf8'), 'video bytes');
  assert.match(path.basename(image), /^poster-[0-9a-f]{12}\.png$/);
  assert.match(path.basename(video), /^clip-[0-9a-f]{12}\.mp4$/);
});

test('sequence frames target a named folder below sequences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-sequence-target-'));
  const project = path.join(root, 'Board.netsu');
  const dir = target.sequenceDir(project, 'Opening Frames');
  assert.equal(dir, path.join(root, 'Board.medias', 'sequences', 'opening-frames'));
});
