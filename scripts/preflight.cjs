// Refuses to start the dev host while an installed copy of the extension is around:
// both copies load with the same id, the second registration throws, the extension
// host dies and the window closes without a word in the Debug Console.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = os.homedir();
const roots = [
  path.join(home, '.vscode', 'extensions'),
  path.join(home, '.vscode-insiders', 'extensions'),
  path.join(home, '.vscode-oss', 'extensions'),
  path.join(home, '.cursor', 'extensions'),
];

const found = [];
for (const root of roots) {
  if (!fs.existsSync(root)) {
    continue;
  }
  for (const entry of fs.readdirSync(root)) {
    if (!entry.startsWith('mercurykd.githelm') && !entry.endsWith('.githelm')) {
      continue;
    }
    const manifest = path.join(root, entry, 'package.json');
    let version = '?';
    let publisher = '';
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      version = parsed.version ?? '?';
      publisher = `${parsed.publisher ?? ''}.${parsed.name ?? ''}`;
    } catch {
      // A half-removed folder still counts: it is what breaks the launch.
    }
    found.push({ entry, version, publisher, root });
  }
}

// The launch config can keep installed extensions out of the dev host: `--disable-extensions`
// leaves only the extension under development (built-ins such as the git extension stay
// active), and it is a property of the host process rather than of a profile, so opening
// another folder does not bring the installed copy back. `--profile-temp` is the older
// clean-profile spelling; it works too, but it is tied to the folder it was launched with.
let isolated = false;
try {
  const launch = fs.readFileSync(path.join(__dirname, '..', '.vscode', 'launch.json'), 'utf8');
  isolated = launch.includes('--disable-extensions') || launch.includes('--profile-temp');
} catch {
  isolated = false;
}

if (found.length === 0) {
  console.log('[preflight] no installed copy of the extension — the dev host is safe to start');
  process.exit(0);
}

if (isolated) {
  console.log('[preflight] an installed copy is present, but the launch config keeps it out of the dev host:');
  for (const item of found) {
    console.log(`  ${item.entry}  version=${item.version}  ${item.publisher ? `(${item.publisher})` : ''}`);
  }
  console.log('  F5 disables installed extensions and loads only the development copy.');
  process.exit(0);
}

console.warn('');
console.warn('[preflight] Git Helm is installed as well as being developed:');
for (const item of found) {
  console.warn(`  ${item.entry}  version=${item.version}  ${item.publisher ? `(${item.publisher})` : ''}`);
}
console.warn('');
console.warn('Both copies load in the dev host with the same id, the second registration');
console.warn('throws and the extension host dies — the window closes with an empty console.');
console.warn('');
console.warn('Fix it for the run, then start F5 again:');
console.warn('  code --uninstall-extension mercurykd.githelm');
console.warn('');
console.warn('Or keep it installed and only disable it while working:');
console.warn('  Extensions view -> Git Helm -> Disable (for this profile)');
console.warn('');
console.warn('Or start the dev host with installed extensions off, as the launch config does:');
console.warn('  --disable-extensions  (built-ins stay on; survives opening another folder)');
console.warn('See docs/webview-status.md.');
// A warning only: the copies usually coexist, and the launch must not stop here.
process.exit(0);
