// Renders the models with the real client bundle into static HTML pages, so the
// layout can be screenshotted without VS Code. Headless Edge/Chrome only.
const fs = require('node:fs');
const path = require('node:path');
const { buildStatusModel } = require('../build/src/webview/model/status.js');
const { buildBranchesModel } = require('../build/src/webview/model/branches.js');
const { buildTagsModel } = require('../build/src/webview/model/tags.js');
const { buildLogModel } = require('../build/src/webview/model/log.js');
const { listBranchEntries } = require('../build/src/git/actions.js');
const { listTags } = require('../build/src/git/tags.js');
const { readLog } = require('../build/src/git/log.js');
const { buildDocModel } = require('../build/src/webview/model/doc.js');
const { fileLog } = require('../build/src/git/fileHistory.js');

const repoRoot = path.join(__dirname, '..');
const outDir = path.join(repoRoot, 'build', 'preview');
fs.mkdirSync(outDir, { recursive: true });

const model = buildStatusModel({
  repoPath: 'D:/domains/vpn',
  status: {
    branch: 'dev',
    ahead: 0,
    behind: 0,
    head: '9a7e4eb',
    headSubject: 'refactor(bot): isolate WireGuard instance state across calls',
    entries: [
      { section: 'unstaged', xy: ' M', path: 'app/bot.php' },
      { section: 'unstaged', xy: ' M', path: 'app/i18n.php' },
    ],
  },
  remotes: [
    { name: 'codeberg', url: 'ssh://git@codeberg.org/mercury/vpnbot.git' },
    { name: 'legiz-ru', url: 'git@github.com:legiz-ru/vpnbot' },
    { name: 'origin', url: 'git@github.com:mercurykd/vpnbot.git' },
  ],
  stashes: [
    { ref: 'stash@{0}', subject: 'On dev: hop' },
    { ref: 'stash@{1}', subject: 'On dev: mtproto443' },
    { ref: 'stash@{2}', subject: 'On dev: simplexray' },
    { ref: 'stash@{3}', subject: 'On master: f2b' },
    { ref: 'stash@{4}', subject: 'On singbox: sing' },
    { ref: 'stash@{5}', subject: 'On singbox: trojan + steal from self' },
    { ref: 'stash@{6}', subject: 'On master: redirect' },
  ],
  worktrees: [
    { path: 'D:/domains/vpn', head: '9a7e4eb', branch: 'dev', bare: false, detached: false, locked: false },
    { path: 'D:/domains/vpn2', head: '591609b', branch: 'master', bare: false, detached: false, locked: false },
  ],
  commits: [
    { shortSha: '9a7e4eb', date: '2026-11-13 16:07', author: 'mercury', refs: ['HEAD -> main', 'tag: v0.0.4'], subject: 'refactor(bot): isolate WireGuard instance state across calls' },
    { shortSha: '591609b', date: '2026-11-12 10:11', author: 'mercury', refs: ['origin/main'], subject: 'feat: add reverse proxy for Telegram API in nginx configuration, and a very long subject that cannot fit one line of the panel' },
    { shortSha: 'aa28234', date: '2026-11-09 23:56', author: 'mercury', subject: 'feat: enhance output in dockerExecOut with additional client endpoint and DNS resolution details' },
    { shortSha: '33c50cd', date: '2026-11-09 23:42', author: 'mercury', subject: 'feat: add output for latest handshakes and recent status in dockerExecOut' },
  ],
  upstream: { ref: 'origin/dev', ahead: 0, behind: 0 },
  remote: { name: 'origin', url: 'git@github.com:mercurykd/vpnbot.git' },
});

// A dark theme, close to the default one, so the preview shows real colours.
const theme = `
  --vscode-font-family: system-ui, sans-serif;
  --vscode-editor-font-family: Consolas, 'Courier New', monospace;
  --vscode-editor-font-size: 13px;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #8b8b8b;
  --vscode-textLink-foreground: #4daafc;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-editorWidget-border: #454545;
  --vscode-gitDecoration-addedResourceForeground: #81b88b;
  --vscode-gitDecoration-modifiedResourceForeground: #e2c08d;
  --vscode-gitDecoration-untrackedResourceForeground: #73c991;
  --vscode-gitDecoration-conflictingResourceForeground: #e4676b;
  --vscode-notifications-background: #252526;
  --vscode-notifications-foreground: #cccccc;
  --vscode-notifications-border: #454545;
`;

const page = (model) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Git Helm — webview preview</title>
<style>:root { ${theme} }</style>
<link rel="stylesheet" href="../../media/webview/style.css">
</head>
<body>
<div id="app"></div>
<script>
  const model = ${JSON.stringify(model)};
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      if (message && message.type === 'ready') {
        window.postMessage({ type: 'model', model }, '*');
      }
    },
    getState: () => undefined,
    setState: () => undefined,
  });
</script>
<script type="module" src="../../dist/webview-client/client/main.js"></script>
</body>
</html>`;

const write = (name, model) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, page(model));
  console.log(file.replace(repoRoot + path.sep, ''));
};

write('status.html', model);

// The other panels are rendered from the repository this script lives in, so the rows
// are real branches and tags.
(async () => {
  const repo = repoRoot;
  const entries = await listBranchEntries(repo, true);
  write('branches.html', buildBranchesModel(repo, entries, true));
  write('tags.html', buildTagsModel(repo, await listTags(repo)));
    // The history screen reads the same 200-commit page the panel reads.
  write(
    'log.html',
    buildLogModel({
      repoPath: repo,
      parsed: await readLog(repo, { limit: 200 }),
      all: false,
      filter: {},
      sort: 'topo',
      limit: 200,
    })
  );

  // A file's history, as the panel still draws it. A blame used to be the document whose
  // rows were a table; it is the file itself in a real editor now, with the metadata drawn
  // in front of the line by a decoration — a preview page has no grammar to highlight it
  // with, so there is nothing here to render.
  const log = await fileLog(repo, 'src/webview/model/doc.ts');
  write(
    'file.html',
    buildDocModel({
      screen: 'file',
      title: 'src/webview/model/doc.ts',
      text: log.text,
      spans: log.spans,
      selectFirst: '',
      emptyText: 'nothing to blame',
    })
  );})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
