// One build for the whole test run, before any test file starts.
//
// Two test files need dist/main.js: src/main.test.ts executes the CLI, and
// scripts/package-bin.test.mjs stats its permission bits. Building inside
// either of them races the other, because a build is not atomic — vite's
// emptyOutDir removes dist/main.js and writes it back as 0644, and
// ensure-bin-executable chmods it to 0755 a moment later. A parallel worker
// that stats the file inside that window sees a mode the build has not
// finished setting, which failed the packaging test on roughly half of all
// runs (and would have failed CI and `pnpm release` just as often).
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export default function setup() {
    // shell:true so Windows resolves `pnpm` to `pnpm.cmd` through PATHEXT;
    // execFile alone would only try pnpm.exe.
    execFileSync('pnpm', ['build'], { cwd: root, stdio: 'ignore', shell: true });
}
