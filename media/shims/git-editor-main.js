'use strict';

// Git Helm editor shim — runs inside node (or Electron with RUN_AS_NODE=1).
// git invokes it with the path of the file to edit; the extension decides what
// the new content is. Exit code != 0 aborts the git operation.

const fs = require('node:fs');
const http = require('node:http');

const filePath = process.argv[process.argv.length - 1];
const url = new URL(process.env.GITHELM_URL || 'http://127.0.0.1:0');
const token = process.env.GITHELM_TOKEN || '';

function fail(message) {
  process.stderr.write(`githelm shim: ${message}\n`);
  process.exit(1);
}

if (!filePath) {
  fail('no file argument');
}

let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch (error) {
  fail(`cannot read ${filePath}: ${error.message}`);
}

const payload = JSON.stringify({ token, path: filePath, content });

const request = http.request(
  {
    hostname: url.hostname,
    port: url.port,
    path: '/edit',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
  },
  (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => (body += chunk));
    response.on('end', () => {
      if (response.statusCode !== 200) {
        fail(`editor aborted (${response.statusCode})`);
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        fail(`bad response: ${error.message}`);
      }
      if (typeof parsed.content !== 'string') {
        fail('response has no content');
      }
      fs.writeFileSync(filePath, parsed.content, 'utf8');
      process.exit(0);
    });
  }
);

request.on('error', (error) => fail(error.message));
request.end(payload);
