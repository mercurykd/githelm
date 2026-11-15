const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const problems = [];

const commandIds = new Set((pkg.contributes?.commands ?? []).map((entry) => entry.command));

for (const binding of pkg.contributes?.keybindings ?? []) {
  if (!commandIds.has(binding.command)) {
    problems.push(`keybinding references unknown command: ${binding.command}`);
  }
}

for (const [menu, items] of Object.entries(pkg.contributes?.menus ?? {})) {
  for (const item of items) {
    if (!commandIds.has(item.command)) {
      problems.push(`menu ${menu} references unknown command: ${item.command}`);
    }
  }
}

const mainPath = path.join(__dirname, '..', pkg.main ?? '');
if (!fs.existsSync(mainPath)) {
  problems.push(`main entry is missing: ${pkg.main} (run npm run build)`);
}

if (pkg.icon && !fs.existsSync(path.join(__dirname, '..', pkg.icon))) {
  problems.push(`icon is missing: ${pkg.icon}`);
}

if (!fs.existsSync(path.join(__dirname, '..', 'CHANGELOG.md'))) {
  problems.push('CHANGELOG.md is missing (required for a useful Marketplace page)');
}

const shimsDir = path.join(__dirname, '..', 'dist', 'shims');
for (const shim of ['git-editor.sh', 'git-editor-main.js']) {
  if (!fs.existsSync(path.join(shimsDir, shim))) {
    problems.push(`shim is missing: dist/shims/${shim} (run npm run build)`);
  }
}

// Every readme has to exist and link to the other two, or the language switcher
// at the top of a page keeps pointing at a file nobody ships.
const readmes = ['README.md', 'README.ru.md', 'README.zh.md'];
for (const readme of readmes) {
  const file = path.join(__dirname, '..', readme);
  if (!fs.existsSync(file)) {
    problems.push(`readme is missing: ${readme}`);
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const other of readmes) {
    if (other === readme) {
      continue;
    }
    if (!text.includes(`(${other})`)) {
      problems.push(`${readme} does not link to ${other}`);
    }
  }
}

// Screenshots live in the repository and every readme shows the same ones, so a
// missing file, an oversized recording or a page that forgot the images is caught
// before packaging instead of on the Marketplace page.
const IMAGE_LIMIT = 3 * 1024 * 1024;
const TOTAL_IMAGE_LIMIT = 10 * 1024 * 1024;
const mediaRoot = path.join(__dirname, '..', 'media');
const imageSets = new Map();
const images = new Map();

for (const readme of readmes) {
  const file = path.join(__dirname, '..', readme);
  if (!fs.existsSync(file)) {
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  const sources = [
    ...[...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]),
    ...[...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]),
  ];
  const local = [...new Set(sources.filter((source) => !/^[a-z][a-z0-9+.-]*:/i.test(source)))];
  imageSets.set(readme, local);
  for (const relative of local) {
    if (!relative.startsWith('media/') || /\s/.test(relative)) {
      problems.push(`${readme} references an image outside media/ or with whitespace: ${relative}`);
      continue;
    }
    const target = path.resolve(__dirname, '..', relative);
    if (!target.startsWith(mediaRoot + path.sep)) {
      problems.push(`${readme} references an image outside media/: ${relative}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      problems.push(`${readme} references a missing image: ${relative}`);
      continue;
    }
    if (!['.png', '.gif', '.jpg', '.jpeg', '.webp'].includes(path.extname(target).toLowerCase())) {
      problems.push(`image must be png, gif, jpg or webp: ${relative}`);
    }
    const size = fs.statSync(target).size;
    if (size > IMAGE_LIMIT) {
      problems.push(`${relative} is ${Math.round(size / 1024)} KB, over the ${IMAGE_LIMIT / 1024 / 1024} MB limit`);
    }
    if (!images.has(relative)) {
      images.set(relative, size);
    }
  }
}

const expected = (imageSets.get('README.md') ?? []).join(',');
for (const [readme, local] of imageSets) {
  if (local.join(',') !== expected) {
    problems.push(`${readme} shows ${local.length} screenshots but README.md shows ${expected ? expected.split(',').length : 0}`);
  }
}

const totalImageBytes = [...images.values()].reduce((sum, size) => sum + size, 0);
if (totalImageBytes > TOTAL_IMAGE_LIMIT) {
  problems.push(`screenshots take ${Math.round(totalImageBytes / 1024)} KB together, over the ${TOTAL_IMAGE_LIMIT / 1024 / 1024} MB budget`);
}


// The Marketplace matches the display name and the description, so all
// of it has to stay filled in - and the description short enough for the listing page.
if (!pkg.displayName) {
  problems.push('displayName is missing');
}

const description = typeof pkg.description === 'string' ? pkg.description : '';
if (description.length < 60 || description.length > 270) {
  problems.push(`description must be 60..270 characters for the listing page, got ${description.length}`);
}
if (!description.toLowerCase().includes('git')) {
  problems.push('description does not mention git');
}

const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
if (keywords.length < 10) {
  problems.push(`keywords must list at least 10 entries, got ${keywords.length}`);
}
for (const keyword of keywords) {
  if (typeof keyword !== 'string' || keyword.trim() === '' || keyword !== keyword.trim().toLowerCase()) {
    problems.push(`keyword must be a trimmed lowercase string: ${JSON.stringify(keyword)}`);
  }
}

if (!(pkg.categories ?? []).includes('SCM Providers')) {
  problems.push('categories must include SCM Providers so the extension shows up in that filter');
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`manifest ok: ${commandIds.size} commands, ${(pkg.contributes?.keybindings ?? []).length} keybindings, ${images.size} screenshots`);
