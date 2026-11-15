const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'media', 'shims');
const target = path.join(__dirname, '..', 'dist', 'shims');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });

// A CRLF line ending breaks `#!/bin/sh` under git's shell, and git may check
// the shim out with autocrlf on Windows. Normalise the shell script explicitly.
for (const entry of fs.readdirSync(target)) {
  if (!entry.endsWith('.sh')) {
    continue;
  }
  const file = path.join(target, entry);
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(file, text, { mode: 0o755 });
}

console.log(`[copy-shims] ${target}`);
