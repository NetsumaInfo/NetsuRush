const fs = require('fs');
const P = 'server.mjs';
let t = fs.readFileSync(P, 'utf8');
const edits = [];

edits.push([
`    sessionFile: readArg('--session', undefined),
  });`,
`    sessionFile: readArg('--session', undefined),
    // Paste mode is an editing loop, so it pre-renders by default and gets a
    // cache big enough to hold what it pre-renders: at 8.3 MiB a 1080p frame,
    // 1 GiB is about 120 frames, five seconds at 24 fps.
    prefetch: pasteMode ? !args.includes('--no-prefetch') : args.includes('--prefetch'),
    cacheBytes: Number(readArg('--cache-mb', pasteMode ? '1024' : '256')) * 1024 * 1024,
  });`,
]);

edits.push([
`  process.stdout.write(\`\${JSON.stringify({ port: server.port, sessionFile: server.sessionFile })}\n\`);`,
`  server.prefetch(bindingId);
  process.stdout.write(\`\${JSON.stringify({ port: server.port, sessionFile: server.sessionFile })}\n\`);`,
]);

for (const [a, b] of edits) {
  if (t.split(a).length !== 2) throw new Error('anchor: ' + a.slice(0, 60));
  t = t.replace(a, b);
}
fs.writeFileSync(P, t);
console.log('ok');
