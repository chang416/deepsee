import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = resolve('dist/main.js');
if (!existsSync(entry)) {
    throw new Error(`Cannot prepare npm CLI: missing build output ${entry}`);
}
if (!readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node')) {
    throw new Error('Cannot prepare npm CLI: dist/main.js is missing its Node.js shebang');
}

if (process.platform !== 'win32') {
    chmodSync(entry, 0o755);
    if ((statSync(entry).mode & 0o111) === 0) {
        throw new Error('Cannot prepare npm CLI: dist/main.js is not executable');
    }
}
