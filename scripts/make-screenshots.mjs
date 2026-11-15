// Builds the two demo screens the README shows. The layout comes from the real
// renderers (`renderStatus`, `renderLog`) and the colours from the real
// manifest, so a screenshot cannot drift from the buffers it advertises; only
// the repository data is a fixture, because the sandbox this runs in cannot
// start `git`.
//
//   node scripts/make-screenshots.mjs && python scripts/make-screenshots.py
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'build', 'screens.json');

const { renderStatus } = await import('../build/src/views/statusRender.js');
const { renderLog } = await import('../build/src/views/logRender.js');
const { parseLog } = await import('../build/src/git/log.js');

const SEP = '\x1f';
const line = (prefix, sha, parents, refs, author, date, subject) =>
  [prefix, sha, sha.slice(0, 7), parents, author, date, subject, refs].join(SEP);

const history = [
  line(
    '*   ',
    'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a 2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b',
    'HEAD -> main, origin/main',
    'Ada Lovelace',
    '2 days ago',
    'Merge branch feature/graph'
  ),
  line(
    '|\\  ',
    '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a',
    '3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c',
    '',
    'Ada Lovelace',
    '3 days ago',
    'Document the key bindings'
  ),
  line(
    '| * ',
    '2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b',
    '3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c',
    'feature/graph',
    'Grace Hopper',
    '3 days ago',
    'Draw the commit graph'
  ),
  line(
    '|/  ',
    '3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c',
    '4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d',
    'tag: v0.1.0',
    'Ada Lovelace',
    '5 days ago',
    'Add the history buffer'
  ),
  line(
    '*   ',
    '4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d',
    '5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
    '',
    'Grace Hopper',
    '1 week ago',
    'Render the status buffer'
  ),
  line(
    '*   ',
    '5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
    '',
    '',
    'Ada Lovelace',
    '2 weeks ago',
    'Start the extension'
  ),
];

const parsed = parseLog(`${history.join('\n')}\n`);

const status = {
  branch: 'main',
  ahead: 2,
  behind: 1,
  head: 'f0f0f0f',
  headSubject: 'Merge branch feature/graph',
  entries: [
    { section: 'staged', xy: 'M ', path: 'src/app.ts' },
    { section: 'staged', xy: 'D ', path: 'docs/keys.md' },
    { section: 'unstaged', xy: ' M', path: 'src/status.ts' },
    { section: 'unstaged', xy: ' M', path: 'src/log.ts' },
    { section: 'untracked', xy: '??', path: 'notes/todo.md' },
    { section: 'untracked', xy: '??', path: 'scripts/screenshots.mjs' },
  ],
};

const extras = {
  stashes: [{ ref: 'stash@{0}', subject: 'WIP on main: try the hint column' }],
  remotes: [{ name: 'origin', url: 'git@github.com:mercurykd/githelm.git' }],
  worktrees: [
    { path: '/work/githelm', head: 'f0f0f0f', branch: 'main', bare: false, detached: false, locked: false, prunable: false },
    {
      path: '/work/githelm-docs',
      head: '1a1a1a1',
      branch: 'docs/handbook',
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    },
    { path: '/work/githelm-release', head: '3c3c3c3', branch: 'v0.1.0', bare: false, detached: false, locked: false, prunable: true },
  ],
  upstream: { ref: 'origin/main', ahead: 2, behind: 1 },
  // The header names the remote the branch tracks, so the demo passes it too:
  // without it the `REMOTE:` line would say "no upstream" right under a
  // divergence taken from that upstream.
  remote: { name: 'origin', url: 'git@github.com:mercurykd/githelm.git' },
  commits: parsed.commits.slice(0, 4).map((entry) => ({
    shortSha: entry.shortSha,
    date: entry.date,
    author: entry.author,
    subject: entry.subject,
    ...(entry.refs.length > 0 ? { refs: entry.refs } : {}),
  })),
};

const palette = {};
for (const color of JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.colors) {
  palette[color.id] = color.defaults.dark;
}

// The span-to-colour map, read from the block that actually paints the buffers.
const highlight = fs.readFileSync(path.join(root, 'src', 'views', 'highlight.ts'), 'utf8');
const colorsBlock = /const COLORS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(highlight);
if (!colorsBlock) {
  throw new Error('COLORS map not found in src/views/highlight.ts');
}
const kinds = {};
for (const match of colorsBlock[1].matchAll(/'?([a-z-]+)'?:\s*'(githelm\.[a-z-]+)'/g)) {
  kinds[match[1]] = match[2];
}
// The span kinds come from the `SpanKind` union, so a new kind cannot be
// forgotten here: the count is read from the type instead of being typed in.
const spanSource = fs.readFileSync(path.join(root, 'src', 'util', 'span.ts'), 'utf8');
const union = /export type SpanKind =([\s\S]*?);/.exec(spanSource);
if (!union) {
  throw new Error('SpanKind union not found in src/util/span.ts');
}
const declared = [...union[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
if (declared.length !== Object.keys(kinds).length) {
  const painted = new Set(Object.keys(kinds));
  const missing = declared.filter((kind) => !painted.has(kind));
  throw new Error(`the COLORS map paints ${Object.keys(kinds).length} of ${declared.length} kinds, missing: ${missing.join(', ')}`);
}

const statusScreen = renderStatus('/work/githelm', status, extras);
const logScreen = renderLog(parsed, {
  repoPath: '/work/githelm',
  all: false,
  filter: { author: 'ada' },
  sort: 'topo',
});

const screens = [
  { name: 'status', lines: statusScreen.text.replace(/\n$/, '').split('\n'), spans: statusScreen.spans },
  { name: 'log', lines: logScreen.lines, spans: logScreen.spans },
];

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ palette, kinds, foreground: '#cccccc', screens }, null, 2)}\n`);

for (const screen of screens) {
  console.log(`${screen.name}: ${screen.lines.length} lines, ${Math.max(...screen.lines.map((text) => text.length))} columns`);
}
