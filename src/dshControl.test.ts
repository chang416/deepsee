import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

// The shipped dsh control plane is dependency-free JavaScript by design.
// @ts-expect-error no declaration file is published for the internal module
const control = await import('../dsh/control.js');
const {
    AUTO_ASSIGNMENTS,
    chooseLane,
    normalizeControlSettings,
    publicControlSettings,
    updateControlFile,
} = control;

describe('DeepSee control settings', () => {
    it('normalizes a complete safe Auto policy and never returns key material', () => {
        const settings = normalizeControlSettings({
            providers: { 'gemini-api': { apiKey: 'legacy', apiKeys: ['new', 'new', '  '] } },
            routing: { customize: { assignments: { security: 'flash' }, maxParallel: 99 } },
        });
        expect(settings.keyCount).toBe(2);
        expect(settings).not.toHaveProperty('apiKey');
        expect(settings).not.toHaveProperty('apiKeys');
        expect(settings.assignments.security).toBe('flash');
        expect(settings.assignments.architecture).toBe(AUTO_ASSIGNMENTS.architecture);
        expect(settings.assignments['ui-implementation']).toBe('flash');
        expect(settings.assignments['visual-review']).toBe('pro');
        expect(settings.maxParallel).toBe(6);
        expect(settings.visualCheck).toEqual({
            enabled: true,
            milestones: true,
            final: true,
            maxRounds: 2,
            previewUrl: '',
            viewport: '1440x900',
        });
    });

    it('writes newline keys atomically, deduplicates them, and persists Customize', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-control-'));
        const file = path.join(dir, 'config.json');
        const settings = await updateControlFile(
            {
                keysText: 'AIza-one\nAIza-two\nAIza-one',
                assignments: { architecture: 'flash', tests: 'pro' },
                maxParallel: 4,
                visualCheck: {
                    enabled: true,
                    milestones: false,
                    final: true,
                    maxRounds: 3,
                    previewUrl: ' http://127.0.0.1:4173 ',
                    viewport: ' 1920x1080 ',
                },
            },
            file,
        );
        expect(settings).toMatchObject({ keyCount: 2, customizeConfigured: true, maxParallel: 4 });
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(stored.providers['gemini-api'].apiKeys).toEqual(['AIza-one', 'AIza-two']);
        expect(stored.providers['gemini-api']).not.toHaveProperty('apiKey');
        expect(stored.routing.customize.assignments.architecture).toBe('flash');
        expect(stored.routing.visualCheck).toEqual({
            enabled: true,
            milestones: false,
            final: true,
            maxRounds: 3,
            previewUrl: 'http://127.0.0.1:4173',
            viewport: '1920x1080',
        });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        const publicAgain = await publicControlSettings(file);
        expect(JSON.stringify(publicAgain)).not.toContain('AIza');
    });

    it('uses preset routing in Auto and saved routing in Customize', () => {
        const settings = normalizeControlSettings({
            routing: { customize: { configured: true, assignments: { architecture: 'flash' } } },
        });
        expect(chooseLane('design the architecture', 'architecture', 'auto', settings)).toBe('pro');
        expect(chooseLane('design the architecture', 'architecture', 'customize', settings)).toBe(
            'flash',
        );
        expect(chooseLane('unknown small task', 'unknown', 'auto', settings)).toBe('flash');
    });
});

describe('DeepSee native dsh router', () => {
    it('publishes Auto and Customize and routes OpenCode free Flash versus Go/Pro-capable lanes', async () => {
        // @ts-expect-error shipped plugin is plain JavaScript
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const tools = new Map<string, Record<string, unknown>>();
        let adapter: Record<string, CallableFunction> | undefined;
        const streamed: Array<Record<string, unknown>> = [];
        const starts: Array<Record<string, unknown>> = [];
        const models = [
            { provider: 'opencode', id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
            { provider: 'opencode', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ];
        const ctx: Record<string, unknown> = {
            tools: {
                register: (tool: { name: string }) => {
                    tools.set(tool.name, tool as unknown as Record<string, unknown>);
                },
            },
            attachments: {},
            agents: {},
            on: () => {},
            llm: {
                registerAdapter: (
                    _providers: string[],
                    value: Record<string, CallableFunction>,
                ) => {
                    adapter = value;
                },
                listModels: async () => models,
                resolveModelInfo: async (_provider: string, model: string) =>
                    models.find((item) => item.id === model),
                stream: (options: Record<string, unknown>) => {
                    streamed.push(options);
                    return (async function* () {})();
                },
            },
            subagents: {
                start: async (_provider: string, request: Record<string, unknown>) => {
                    starts.push(request);
                    return {
                        result: Promise.resolve({
                            stopReason: 'completed',
                            output: [{ type: 'text', text: 'child complete' }],
                        }),
                        dispose: async () => {},
                    };
                },
            },
        };
        ctx.inject = (services: string[], callback: (scope: unknown) => void) => {
            if (services.includes('subagents')) callback(ctx);
        };

        plugin.apply(ctx, { upstream: 'opencode', providerId: 'deepsee-opencode' });
        expect(adapter).toBeDefined();
        const registeredAdapter = adapter;
        if (!registeredAdapter) throw new Error('DeepSee adapter was not registered');
        const listed = (await registeredAdapter.listModels('deepsee-opencode')) as Array<{
            id: string;
        }>;
        expect(listed.map((item) => item.id)).toEqual(
            expect.arrayContaining(['deepsee-auto', 'deepsee-customize']),
        );

        for await (const _chunk of registeredAdapter.stream({
            provider: 'deepsee-opencode',
            model: 'deepsee-auto',
            messages: [],
            system: 'base',
        }) as AsyncIterable<unknown>) {
            // drain
        }
        expect(streamed[0]).toMatchObject({
            provider: 'opencode',
            model: 'deepseek-v4-flash-free',
        });
        expect(String(streamed[0].system)).toContain('multi-model coordinator');
        expect(String(streamed[0].system)).toContain('deepsee_visual_check');
        expect(String(streamed[0].system)).toContain(
            'Never claim completion without a PASS verdict',
        );
        expect(tools.has('deepsee_visual_check')).toBe(true);

        const delegate = tools.get('deepsee_delegate') as {
            execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>;
        };
        const exec = {
            agent: { options: { provider: 'deepsee-opencode', model: 'deepsee-auto' } },
            signal: new AbortController().signal,
        };
        const flash = await delegate.execute(
            { description: 'tests', task: 'add a focused test', category: 'tests' },
            exec,
        );
        const pro = await delegate.execute(
            {
                description: 'architecture',
                task: 'design a secure architecture',
                category: 'architecture',
            },
            exec,
        );
        expect(flash).toMatchObject({ lane: 'flash', model: 'deepseek-v4-flash-free' });
        expect(pro).toMatchObject({ lane: 'pro', model: 'deepseek-v4-pro' });
        expect(starts[0].agentOptions).toEqual({
            provider: 'opencode',
            model: 'deepseek-v4-flash-free',
        });
        expect(starts[1].agentOptions).toEqual({ provider: 'opencode', model: 'deepseek-v4-pro' });
    });

    it('uses Gemini for deterministic visual verdicts and caches identical screenshots', async () => {
        // @ts-expect-error shipped plugin is plain JavaScript
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const tools = new Map<string, Record<string, unknown>>();
        plugin.apply(
            {
                tools: {
                    register: (tool: { name: string }) =>
                        tools.set(tool.name, tool as unknown as Record<string, unknown>),
                },
                attachments: {},
                agents: {},
                on: () => {},
            },
            { visionProvider: false, pasteToPath: false },
        );
        const visualCheck = tools.get('deepsee_visual_check') as {
            execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>;
        };
        expect(visualCheck).toBeDefined();

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-visual-integration-'));
        const image = path.join(dir, 'preview.png');
        fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
        const fakeCli = path.join(dir, 'fake-cli.js');
        fs.writeFileSync(
            fakeCli,
            `if (!process.argv.includes('gemini-api')) process.exit(11)
console.log(JSON.stringify({
  provider: 'gemini-api',
  result: {
    summary: 'NEEDS_FIX: Primary action is clipped.',
    ocr: { full_text: 'Save', lines: [{ text: 'Save' }] },
    layout: { regions: [{ type: 'form', reading_order: 1, text: 'Save' }] },
    semantics: { scene: 'Settings screen', entities: [{ name: 'Save', type: 'button', evidence: 'right edge clipped' }] },
    visual: { dominant_colors: ['#000000'], style: 'dark', notes: [] },
    uncertainty: ['HIGH: bottom-right Save button is clipped; add safe-area spacing.']
  },
  meta: { model: 'gemini-3.7-flash', usage: { inputTokens: 12, outputTokens: 8 } }
}))`,
        );
        const oldCli = process.env.DEEPSEE_DSH_CLI;
        const oldConfig = process.env.DEEPSEE_CONFIG_PATH;
        process.env.DEEPSEE_DSH_CLI = fakeCli;
        process.env.DEEPSEE_CONFIG_PATH = path.join(dir, 'config.json');
        try {
            const agent = {};
            const args = {
                imagePath: image,
                criteria: 'The settings screen is readable and every action is fully visible.',
                phase: 'final',
            };
            const first = await visualCheck.execute(args, {
                agent,
                signal: new AbortController().signal,
            });
            const second = await visualCheck.execute(args, {
                agent,
                signal: new AbortController().signal,
            });
            expect(first).toMatchObject({
                verdict: 'needs-fix',
                provider: 'gemini-api',
                model: 'gemini-3.7-flash',
                cacheHit: false,
            });
            expect(second).toMatchObject({ verdict: 'needs-fix', cacheHit: true });
            fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]));
            const nextRender = await visualCheck.execute(args, {
                agent,
                signal: new AbortController().signal,
            });
            expect(nextRender).toMatchObject({ verdict: 'needs-fix', cacheHit: false });
            fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]));
            await expect(
                visualCheck.execute(args, {
                    agent,
                    signal: new AbortController().signal,
                }),
            ).rejects.toThrow(/configured 2-round limit/);
        } finally {
            if (oldCli === undefined) delete process.env.DEEPSEE_DSH_CLI;
            else process.env.DEEPSEE_DSH_CLI = oldCli;
            if (oldConfig === undefined) delete process.env.DEEPSEE_CONFIG_PATH;
            else process.env.DEEPSEE_CONFIG_PATH = oldConfig;
        }
    });

    it('can pair OpenCode free Flash with OpenCode Go Pro across live routes', async () => {
        // @ts-expect-error shipped plugin is plain JavaScript
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const adapters = new Map<string, Record<string, CallableFunction>>();
        const tools = new Map<string, Record<string, unknown>>();
        const starts: Array<Record<string, unknown>> = [];
        const catalogs: Record<string, Array<{ provider: string; id: string; name: string }>> = {
            opencode: [
                {
                    provider: 'opencode',
                    id: 'deepseek-v4-flash-free',
                    name: 'DeepSeek V4 Flash Free',
                },
            ],
            'opencode-go': [
                { provider: 'opencode-go', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
                { provider: 'opencode-go', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
            ],
        };
        const ctx: Record<string, unknown> = {
            tools: { register: (tool: { name: string }) => tools.set(tool.name, tool as never) },
            attachments: {},
            agents: {},
            on: () => {},
            emit: () => {},
            llm: {
                listProviders: () => [
                    { id: 'opencode', name: 'OpenCode' },
                    { id: 'opencode-go', name: 'OpenCode Go' },
                ],
                listModels: async (provider: string) => catalogs[provider] ?? [],
                resolveModelInfo: async (provider: string, model: string) =>
                    catalogs[provider]?.find((item) => item.id === model),
                registerAdapter: (
                    providers: string[],
                    adapter: Record<string, CallableFunction>,
                ) => {
                    adapters.set(providers[0], adapter);
                },
                stream: () => (async function* () {})(),
            },
            subagents: {
                start: async (_provider: string, request: Record<string, unknown>) => {
                    starts.push(request);
                    return {
                        result: Promise.resolve({
                            stopReason: 'completed',
                            output: [{ type: 'text', text: 'done' }],
                        }),
                        dispose: async () => {},
                    };
                },
            },
        };
        ctx.inject = (services: string[], callback: (scope: unknown) => void) => {
            if (services.includes('subagents')) callback(ctx);
        };
        plugin.apply(ctx);
        for (let attempt = 0; attempt < 20 && adapters.size < 2; attempt++) await Promise.resolve();
        expect(adapters.has('deepsee-opencode')).toBe(true);
        expect(adapters.has('deepsee-opencode-go')).toBe(true);
        const delegate = tools.get('deepsee_delegate') as {
            execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>;
        };
        const result = await delegate.execute(
            {
                description: 'architecture',
                task: 'design the architecture',
                category: 'architecture',
            },
            {
                agent: { options: { provider: 'deepsee-opencode', model: 'deepsee-auto' } },
                signal: new AbortController().signal,
            },
        );
        expect(result).toMatchObject({
            lane: 'pro',
            provider: 'opencode-go',
            model: 'deepseek-v4-pro',
        });
        expect(starts[0].agentOptions).toEqual({
            provider: 'opencode-go',
            model: 'deepseek-v4-pro',
        });
    });
});

describe('DeepSee settings route', () => {
    it('keeps saved keys write-only and rejects cross-origin writes', async () => {
        // @ts-expect-error shipped plugin is plain JavaScript
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const routes: Array<{ path: string; handler: CallableFunction }> = [];
        const ctx: Record<string, unknown> = {
            tools: { register: () => {} },
            attachments: {},
            agents: {},
            on: () => {},
            webServer: {
                register: (route: { path: string; handler: CallableFunction }) =>
                    routes.push(route),
            },
        };
        ctx.inject = (services: string[], callback: (scope: unknown) => void) => {
            if (services.includes('webServer')) callback(ctx);
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-route-'));
        const oldPath = process.env.DEEPSEE_CONFIG_PATH;
        process.env.DEEPSEE_CONFIG_PATH = path.join(dir, 'config.json');
        try {
            plugin.apply(ctx, { visionProvider: false, pasteToPath: false });
            const route = routes.find((item) => item.path === '/deepsee/settings');
            if (!route) throw new Error('settings route not registered');
            const call = async (method: string, body = '', origin = 'http://127.0.0.1:3000') => {
                const req = Readable.from(body ? [Buffer.from(body)] : []) as Readable & {
                    method: string;
                    headers: Record<string, string>;
                    url: string;
                };
                req.method = method;
                req.url = '/deepsee/settings';
                req.headers = {
                    host: '127.0.0.1:3000',
                    origin,
                    'content-type': 'application/json',
                };
                const out = { status: 0, body: '' };
                const res = {
                    writeHead: (status: number) => {
                        out.status = status;
                        return res;
                    },
                    end: (value = '') => {
                        out.body += value;
                        return res;
                    },
                };
                await route.handler(req, res);
                return out;
            };
            const denied = await call(
                'POST',
                JSON.stringify({ keysText: 'secret' }),
                'https://evil.test',
            );
            expect(denied.status).toBe(403);
            const saved = await call('POST', JSON.stringify({ keysText: 'AIza-one\nAIza-two' }));
            expect(saved.status).toBe(200);
            expect(saved.body).toContain('"keyCount":2');
            expect(saved.body).not.toContain('AIza');
            const fetched = await call('GET');
            expect(fetched.status).toBe(200);
            expect(fetched.body).not.toContain('AIza');
        } finally {
            if (oldPath === undefined) delete process.env.DEEPSEE_CONFIG_PATH;
            else process.env.DEEPSEE_CONFIG_PATH = oldPath;
        }
    });
});
