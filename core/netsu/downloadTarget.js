// @ts-check
// Direct destinations for web media owned by a working .netsu project.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sidecar = require('./sidecar');

/** @param {string} projectPath @param {'image'|'video'} kind */
function bucketDir(projectPath, kind) {
  return path.join(sidecar.sidecarDirFor(projectPath), kind === 'video' ? 'videos' : 'images');
}

/** @param {string} projectPath @param {string} title */
function sequenceDir(projectPath, title) {
  return path.join(sidecar.sidecarDirFor(projectPath), 'sequences', sidecar.slugify(title || 'sequence'));
}

/**
 * @param {string} projectPath @param {'image'|'video'} kind @param {string} title
 * @param {Buffer|Uint8Array} bytes @param {string} ext
 */
function writeBuffer(projectPath, kind, title, bytes, ext) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const extension = String(ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const dir = bucketDir(projectPath, kind);
  const dest = path.join(dir, `${sidecar.slugify(title || kind)}-${hash}.${extension}`);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(dir, { recursive: true });
  const part = `${dest}.part`;
  fs.writeFileSync(part, buffer);
  fs.renameSync(part, dest);
  return dest;
}

module.exports = { bucketDir, sequenceDir, writeBuffer };
