import { describe, expect, it } from 'vitest';
import { parseCmdShimTarget, resolveSpawnPlan } from './winExec.ts';

// Every fixture below is the verbatim output of a real shim generator, run
// against a real file: npm's cmd-shim@9 and pnpm's @zkochan/cmd-shim@9. The
// interpreter must be read out of the shim, never guessed from the entry's
// extension — cmd-shim happily generates a python shim for a file named .js.

/** npm, `#!/usr/bin/env node`. */
const NPM_NODE = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\cli.js" %*`;

/** npm, `#!/usr/bin/env node --max-old-space-size=4096 --no-warnings`. */
const NPM_NODE_FLAGS = NPM_NODE.replace(
    '"%_prog%"  "%dp0%\\..\\cli.js" %*',
    '"%_prog%" --max-old-space-size=4096 --no-warnings "%dp0%\\..\\cli-flags.js" %*',
);

/** npm, `#!/usr/bin/env python`, entry named .js — the trap. */
const NPM_PYTHON_JS = NPM_NODE.replaceAll('node.exe', 'python.exe')
    .replace('SET "_prog=node"', 'SET "_prog=python"')
    .replace('"%dp0%\\..\\cli.js"', '"%dp0%\\..\\python-named.js"');

/** npm, a Node bin with no file extension at all. */
const NPM_NODE_NOEXT = NPM_NODE.replace('"%dp0%\\..\\cli.js"', '"%dp0%\\..\\entry-noext"');

/** npm, `#!/usr/bin/env FOO=bar node`: carries an env assignment. */
const NPM_NODE_ENV_KV = NPM_NODE.replace('CALL :find_dp0\n', 'CALL :find_dp0\n@SET FOO=bar\n');

/** pnpm, standard. */
const PNPM_NODE = `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\cli.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\..\\cli.js" %*
)`;

/** pnpm with nodePath: prepends NODE_PATH, which a direct spawn would drop. */
const PNPM_NODEPATH = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C;\\extra modules"
) ELSE (
  @SET "NODE_PATH=C;\\extra modules;%NODE_PATH%"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\cli.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\..\\cli.js" %*
)`;

/** pnpm with nodeExecPath: pins one Node binary. */
const PNPM_NODEEXEC = `@SETLOCAL
@"C:\\runtimes\\node20\\node.exe"  "%~dp0\\..\\cli.js" %*`;

describe('parseCmdShimTarget', () => {
    it('reads npm Node shims, resolving the entry against the shim directory', () => {
        const target = parseCmdShimTarget('C:\\npm\\bin\\claude.cmd', NPM_NODE);
        expect(target?.script).toBe('C:\\npm\\cli.js');
        expect(target?.nodeFlags).toEqual([]);
        expect(target?.nodeExec).toBeUndefined();
    });

    it('keeps the interpreter flags a shebang injected, in order', () => {
        const target = parseCmdShimTarget('C:\\npm\\bin\\x.cmd', NPM_NODE_FLAGS);
        expect(target?.nodeFlags).toEqual(['--max-old-space-size=4096', '--no-warnings']);
        expect(target?.script).toBe('C:\\npm\\cli-flags.js');
    });

    it('declines a python shim whose entry is named .js', () => {
        // The extension is not evidence of the interpreter: running this
        // under Node would execute a Python program as JavaScript.
        expect(parseCmdShimTarget('C:\\npm\\bin\\tool.cmd', NPM_PYTHON_JS)).toBeNull();
    });

    it('accepts a Node bin with no file extension', () => {
        const target = parseCmdShimTarget('C:\\npm\\bin\\tool.cmd', NPM_NODE_NOEXT);
        expect(target?.script).toBe('C:\\npm\\entry-noext');
    });

    it('declines a shim carrying an environment assignment', () => {
        // `env FOO=bar node` renders as @SET FOO=bar; a direct spawn would
        // silently drop it, so the shim is left to the fallback instead.
        expect(parseCmdShimTarget('C:\\npm\\bin\\kv.cmd', NPM_NODE_ENV_KV)).toBeNull();
    });

    it('reads pnpm shims, and declines the NODE_PATH variant', () => {
        expect(parseCmdShimTarget('C:\\pnpm\\bin\\tool.cmd', PNPM_NODE)?.script).toBe(
            'C:\\pnpm\\cli.js',
        );
        expect(parseCmdShimTarget('C:\\pnpm\\bin\\tool.cmd', PNPM_NODEPATH)).toBeNull();
    });

    it('honours a pinned Node binary instead of the running one', () => {
        const target = parseCmdShimTarget('C:\\pnpm\\bin\\tool.cmd', PNPM_NODEEXEC);
        expect(target?.script).toBe('C:\\pnpm\\cli.js');
        expect(target?.nodeExec).toBe('C:\\runtimes\\node20\\node.exe');
    });

    it('declines content with no forwarded arguments', () => {
        expect(parseCmdShimTarget('C:\\npm\\x.cmd', '@echo off\nnode cli.js')).toBeNull();
    });
});

describe('resolveSpawnPlan', () => {
    it('passes through untouched off Windows', () => {
        const plan = resolveSpawnPlan('claude', ['-p', 'hello'], { PATH: '/usr/bin' });
        expect(plan).toEqual({ command: 'claude', args: ['-p', 'hello'] });
    });

    // The win32 branch is driven with injected deps so it runs on every
    // platform: a real spawn is not needed to prove the plan is correct.
    const winDeps = (files: Record<string, string>, onPath: Record<string, string>) => ({
        platform: 'win32' as NodeJS.Platform,
        readFileSync: (p: string) => {
            const found = files[p];
            if (found === undefined) throw new Error(`ENOENT ${p}`);
            return found;
        },
        resolveOnPath: (bin: string) => onPath[bin] ?? null,
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
    });

    it('rewrites a bare-name shim to a direct node spawn, multi-line prompt intact', () => {
        const shimPath = 'C:\\npm\\bin\\claude.cmd';
        const prompt = 'line one\nline two & echo not-a-command';
        const plan = resolveSpawnPlan(
            'claude',
            ['-p', prompt],
            { PATH: 'C:\\npm\\bin' },
            winDeps({ [shimPath]: NPM_NODE }, { claude: shimPath }),
        );
        expect(plan.command).toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(plan.args[0]).toBe('C:\\npm\\cli.js');
        // The prompt rides as one argv element: newlines and & survive,
        // because no cmd.exe parses this line.
        expect(plan.args[plan.args.length - 1]).toBe(prompt);
    });

    it('rewrites an absolute --provider-bin .cmd path too', () => {
        const shimPath = 'C:\\tools\\claude.CMD';
        const plan = resolveSpawnPlan(
            shimPath,
            ['-p', 'x'],
            {},
            winDeps({ [shimPath]: NPM_NODE }, {}),
        );
        expect(plan.command).toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(plan.args[0]).toBe('C:\\cli.js');
    });

    it('spawns the pinned Node when the shim names one', () => {
        const shimPath = 'C:\\pnpm\\bin\\tool.cmd';
        const plan = resolveSpawnPlan(
            'tool',
            ['x'],
            {},
            winDeps({ [shimPath]: PNPM_NODEEXEC }, { tool: shimPath }),
        );
        expect(plan.command).toBe('C:\\runtimes\\node20\\node.exe');
    });

    it('leaves a declined shim alone so the spawn error names the command', () => {
        const shimPath = 'C:\\npm\\bin\\tool.cmd';
        for (const content of [NPM_PYTHON_JS, NPM_NODE_ENV_KV, '@echo off\nunrecognized']) {
            const plan = resolveSpawnPlan(
                'tool',
                ['x'],
                {},
                winDeps({ [shimPath]: content }, { tool: shimPath }),
            );
            expect(plan).toEqual({ command: shimPath, args: ['x'] });
        }
    });

    it('passes an unresolvable bare name through so ENOENT still names the CLI', () => {
        const plan = resolveSpawnPlan('missing-cli', ['x'], {}, winDeps({}, {}));
        expect(plan).toEqual({ command: 'missing-cli', args: ['x'] });
    });

    it('passes an .exe straight through', () => {
        const exe = 'C:\\tools\\agy.exe';
        const plan = resolveSpawnPlan(exe, ['-i', 'a.png'], {}, winDeps({}, {}));
        expect(plan).toEqual({ command: exe, args: ['-i', 'a.png'] });
    });
});
