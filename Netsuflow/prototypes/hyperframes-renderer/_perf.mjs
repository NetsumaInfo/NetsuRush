import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { MessageReader, MessageType, encodeMessage } from '../fake-renderer/protocol.mjs';
import { fnv1a64Hex } from './server.mjs';

const base = join(process.env.LOCALAPPDATA, 'NetsuRush', 'netsuflow');
const session = JSON.parse(readFileSync(join(base, 'session.json'), 'utf8'));
const hash = fnv1a64Hex(readFileSync(join(base, 'paste', 'index.html'), 'utf8'));

const socket = connect({ host: '127.0.0.1', port: session.port });
socket.setNoDelay(true);
const reader = new MessageReader();
const waiters = [];
socket.on('data', (c) => { reader.push(c); for (const m of reader.drain()) waiters.shift()?.(m); });
const next = () => new Promise((r) => waiters.push(r));
const send = (m) => socket.write(encodeMessage(m));

send({ type: MessageType.HELLO, requestId: 1, metadata: { token: session.token, client: 'perf', instanceId: 'p' } });
await next();

const ask = async (frame, id) => {
  const t = process.hrtime.bigint();
  send({ type: MessageType.FRAME, requestId: id, metadata: {
    binding: 'paste', sourceRevision: hash, frame,
    width: 1920, height: 1080, renderScalePpm: 1000000,
    pixelFormat: 'RGBA8', alphaMode: 'straight', quality: 'preview', deadlineMs: 30000 }});
  const r = await next();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, ok: r.header.type === MessageType.FRAME_OK };
};

await ask(200, 100); // warm, discarded
const seq = [];
for (let i = 0; i < 20; i++) seq.push(await ask(300 + i, 200 + i));
const hit = [];
for (let i = 0; i < 5; i++) hit.push(await ask(305, 400 + i));
const s = seq.map((x) => x.ms).sort((a, b) => a - b);
console.log('sequential fresh frames: p50', s[10].toFixed(1), 'ms  min', s[0].toFixed(1), 'max', s[19].toFixed(1));
console.log('  -> playback ceiling:', (1000 / s[10]).toFixed(1), 'fps');
console.log('cache hits: p50', hit.map((x) => x.ms).sort((a, b) => a - b)[2].toFixed(1), 'ms');
console.log('failures:', seq.filter((x) => !x.ok).length);
socket.destroy();
