import { builtinModules } from 'module';
import { resolve } from 'path';
// vitest/config re-exports vite's defineConfig and adds the `test` key, so one
// config file still serves both the library build and the suite (a separate
// vitest.config.ts would shadow this file and drop __APP_VERSION__).
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    test: {
        // The build is a prerequisite of the whole run, not of one file: doing
        // it in a beforeAll let other workers observe a half-written dist.
        globalSetup: ['./scripts/build-once.mjs'],
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'src/main.ts'),
            formats: ['es'],
            fileName: 'main',
        },
        rollupOptions: {
            // Externalize deps and every Node built-in (bare and node:-prefixed),
            // so adding a new built-in import can never silently bundle to undefined.
            external: [
                'commander',
                // Never bundle undici (issue #23): its internals condition-
                // require node:http2 and friends, which bundling breaks (the
                // embedded ProxyAgent threw "http2.connect is not a function"),
                // and a bundled Dispatcher handed to the host's own fetch is a
                // cross-version interface mismatch (UND_ERR_INVALID_ARG).
                // Resolving it from node_modules keeps dispatcher and fetch
                // same-sourced and intact.
                'undici',
                ...builtinModules,
                ...builtinModules.map((name) => `node:${name}`),
            ],
        },
        commonjsOptions: {
            // Keep undici's lazy require('node:sqlite') a runtime call. The
            // CJS transform used to hoist it into a top-level import, which
            // loaded the experimental module (and printed its warning) on
            // every CLI start, for a cache store nothing here ever uses.
            ignore: ['node:sqlite'],
        },
        target: 'node18',
        outDir: 'dist',
        emptyOutDir: true,
        minify: false,
    },
});
