import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform === 'win32')('npm package CLI', () => {
    it('ships deepsee as an executable command after the build', () => {
        const mode = statSync(resolve('dist/main.js')).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
    });
});
