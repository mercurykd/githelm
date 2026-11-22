// `tsc` writes the files of the sources it is given and never removes the files of the
// sources that are gone, so a module deleted from `src/` keeps its old output in `dist/`
// and ends up in the VSIX. The build starts from an empty `dist/` for that reason.
const fs = require('node:fs');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
console.log(`[clean] ${dist}`);
