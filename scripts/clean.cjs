// `tsc` writes the files of the sources it is given and never removes the files of the
// sources that are gone, so a module deleted from `src/` keeps its old output in `dist/`
// and ends up in the VSIX. The build starts from an empty `dist/` for that reason — and
// from an empty `build/` too, because the test run reads that directory: a test file of a
// deleted screen keeps its old output there, and `node --test` would run it against a
// module that is only a leftover. Both directories are ours alone; nothing else writes
// them and nothing outside them is touched.
const fs = require('node:fs');
const path = require('node:path');

for (const name of ['dist', 'build']) {
  const directory = path.join(__dirname, '..', name);
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(`[clean] ${directory}`);
}
