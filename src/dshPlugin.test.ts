import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { VISION_RESULT_SCHEMA } from './schema.ts';

describe('dsh plugin bundle', () => {
    it('ships a vision schema identical to the source of truth', () => {
        // dsh/index.js cannot import the TS source, so it carries a JSON copy;
        // this is the lockstep check that keeps the copy honest.
        const shipped = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'dsh', 'vision-schema.json'), 'utf-8'),
        );
        expect(shipped).toEqual(VISION_RESULT_SCHEMA);
    });

    it('wires the bundle manifest to the patch and the patch to the subpath', () => {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
        ) as {
            dsh?: { bundle?: { patch?: string } };
            exports?: Record<string, string>;
            files?: string[];
        };
        expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
        expect(pkg.exports?.['.']).toBe('./dsh/index.js');
        expect(pkg.exports?.['./dsh']).toBe('./dsh/index.js');
        expect(pkg.files).toContain('dsh');
        expect(pkg.files).toContain('cordis.patch.yml');
        expect(fs.existsSync(path.join(__dirname, '..', 'dsh', 'visual-check.js'))).toBe(true);
        const patch = fs.readFileSync(path.join(__dirname, '..', 'cordis.patch.yml'), 'utf-8');
        expect(patch).toContain("name: 'deepsee'");
    });
});

describe('dsh plugin auto-read (phase 2)', () => {
    type Handler = (
        payload: { messages: unknown[]; signal?: AbortSignal },
        next: () => Promise<unknown>,
    ) => Promise<{
        kind: string;
        messages?: Array<{ content: Array<{ type: string; text?: string }> }>;
    }>;

    async function load(autoRead: boolean | undefined = true) {
        // The plugin is plain JS by design (no build step, no dsh type deps).
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: { autoRead?: boolean }) => void;
        };
        const handlers: Record<string, Handler> = {};
        const ctx = {
            tools: { register: () => {} },
            attachments: {
                readImage: async () => ({
                    data: new Uint8Array([1, 2, 3]),
                    ref: { mediaType: 'image/png' },
                }),
            },
            on: (event: string, fn: Handler) => {
                handlers[event] = fn;
            },
        };
        plugin.apply(ctx as never, autoRead === undefined ? {} : { autoRead });
        return handlers;
    }

    function fakeCli(body: string): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-dsh-cli-'));
        const file = path.join(dir, 'cli.js');
        fs.writeFileSync(file, body);
        return file;
    }

    const imageMessage = () => ({
        role: 'user',
        content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', attachment: { id: 'a1', mediaType: 'image/png' } },
        ],
    });

    it('rewrites image blocks into deepsee evidence text after next()', async () => {
        const handlers = await load();
        const cli = fakeCli(
            `console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'HELLO-EVIDENCE' }, uncertainty: [] } }))`,
        );
        process.env.DEEPSEE_DSH_CLI = cli;
        try {
            const messages = [imageMessage()];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(decision.kind).toBe('enter');
            const blocks = decision.messages?.[0].content ?? [];
            expect(blocks[0]).toEqual({ type: 'text', text: 'what is this' });
            expect(blocks[1].type).toBe('text');
            expect(blocks[1].text).toContain('HELLO-EVIDENCE');
            expect(blocks[1].text).toContain('Pasted image');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it('names the failure when the attachment store returns no data bytes (#17)', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const handlers: Record<string, Handler> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                // An API-shape drift: readImage resolves, but with no data field.
                attachments: { readImage: async () => ({ ref: { mediaType: 'image/png' } }) },
                on: (event: string, fn: Handler) => {
                    handlers[event] = fn;
                },
            } as never,
            { autoRead: true },
        );
        const messages = [imageMessage()];
        const decision = await handlers['agent/pre-step'](
            { messages, signal: undefined },
            async () => ({ kind: 'enter', messages }),
        );
        const block = decision.messages?.[0].content[1];
        expect(block?.text).toContain('could not be read');
        expect(block?.text).toContain("no 'data' bytes");
    });

    it('writes heic pastes with their real extension and refuses unknown types', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cli = fakeCli(
            `const f = process.argv[3];
             if (!f.endsWith('.heic')) { console.error('wrong ext: ' + f); process.exit(9) }
             console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'HEIC-OK' }, uncertainty: [] } }))`,
        );
        process.env.DEEPSEE_DSH_CLI = cli;
        try {
            const load = (mediaType: string) => {
                const handlers: Record<string, Handler> = {};
                plugin.apply(
                    {
                        tools: { register: () => {} },
                        attachments: {
                            readImage: async () => ({
                                data: new Uint8Array([1]),
                                ref: { mediaType },
                            }),
                        },
                        on: (event: string, fn: Handler) => {
                            handlers[event] = fn;
                        },
                    } as never,
                    { autoRead: true },
                );
                return handlers;
            };
            const messages = [imageMessage()];
            const heic = await load('image/heic')['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(heic.messages?.[0].content[1].text).toContain('HEIC-OK');
            const pdf = await load('application/pdf')['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(pdf.messages?.[0].content[1].text).toContain('unsupported pasted media type');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it('auto-read also converts images nested in tool-result content (#24)', async () => {
        const handlers = await load();
        const cli = fakeCli(
            `console.log(JSON.stringify({ result: { summary: 'S', ocr: { full_text: 'DEEP-NESTED' }, uncertainty: [] } }))`,
        );
        process.env.DEEPSEE_DSH_CLI = cli;
        try {
            // Two levels down: tool-result inside tool-result, image at the bottom.
            const messages = [
                {
                    role: 'tool',
                    content: [
                        {
                            type: 'tool-result',
                            toolCallId: 'outer',
                            content: [
                                {
                                    type: 'tool-result',
                                    toolCallId: 'inner',
                                    content: [{ type: 'image', attachment: { id: 'deep' } }],
                                },
                            ],
                        },
                    ],
                },
            ];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            const outer = decision.messages?.[0].content[0] as unknown as {
                content: Array<{ content: Array<{ type: string; text?: string }> }>;
            };
            expect(outer.content[0].content[0].type).toBe('text');
            expect(outer.content[0].content[0].text).toContain('DEEP-NESTED');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it('degrades a failed read to an explanatory block instead of rejecting the step', async () => {
        const handlers = await load();
        const cli = fakeCli(`console.error('engine down'); process.exit(1)`);
        process.env.DEEPSEE_DSH_CLI = cli;
        try {
            const messages = [imageMessage()];
            const decision = await handlers['agent/pre-step'](
                { messages, signal: undefined },
                async () => ({ kind: 'enter', messages }),
            );
            expect(decision.kind).toBe('enter');
            const block = decision.messages?.[0].content[1];
            expect(block?.text).toContain('could not be read');
            expect(block?.text).toContain('engine down');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it('passes through image-free steps, reject decisions, and autoRead: false', async () => {
        const handlers = await load();
        const plain = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
        const enter = await handlers['agent/pre-step']({ messages: plain }, async () => ({
            kind: 'enter',
            messages: plain,
        }));
        expect(enter.messages).toBe(plain);
        const reject = await handlers['agent/pre-step'](
            { messages: [imageMessage()] },
            async () => ({ kind: 'reject' }),
        );
        expect(reject).toEqual({ kind: 'reject' });
        const off = await load(false);
        expect(off['agent/pre-step']).toBeUndefined();
        // Default config: no auto-read handler (request-time conversion owns it).
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const bare: Record<string, unknown> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: unknown) => {
                    bare[event] = fn;
                },
            } as never,
            {},
        );
        expect(bare['agent/pre-step']).toBeUndefined();
    });
});

describe('dsh plugin vision provider (phase 3)', () => {
    async function loadWith(llm: Record<string, unknown> | undefined, config = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const ctx = {
            tools: { register: () => {} },
            attachments: {},
            on: () => {},
            llm,
        };
        plugin.apply(ctx as never, config);
        return ctx;
    }

    it('registers a wrapper provider that declares image input and delegates', async () => {
        const registered: Array<{
            providers: string[];
            adapter: Record<string, CallableFunction>;
        }> = [];
        const streamed: Array<Record<string, unknown>> = [];
        const llm = {
            registerAdapter: (providers: string[], adapter: Record<string, CallableFunction>) => {
                registered.push({ providers, adapter });
            },
            listModels: async () => [
                {
                    provider: 'deepseek-official',
                    id: 'deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                },
            ],
            resolveModelInfo: async (_p: string, model: string) => ({
                provider: 'deepseek-official',
                id: model,
                name: 'DeepSeek V4 Flash',
                inputModalities: ['text'],
            }),
            stream: (options: Record<string, unknown>) => {
                streamed.push(options);
                return (async function* () {})();
            },
        };
        await loadWith(llm);
        expect(registered[0].providers).toEqual(['deepseek-deepsee']);
        const providerInfo = registered[0].adapter.providerInfo('deepseek-deepsee') as {
            id: string;
            name: string;
        };
        expect(providerInfo.id).toBe('deepseek-deepsee');
        expect(providerInfo.name.length).toBeGreaterThan(0);
        expect(registered[0].adapter.providerRetryPolicy('deepseek-deepsee')).toBeUndefined();
        const adapter = registered[0].adapter;
        const models = (await adapter.listModels('deepseek-deepsee')) as Array<{
            provider: string;
            name: string;
            inputModalities: string[];
        }>;
        expect(models).toHaveLength(1);
        expect(models[0].provider).toBe('deepseek-deepsee');
        expect(models[0].inputModalities).toContain('image');
        expect(models[0].name).toContain('deepsee vision');
        const info = (await adapter.resolveModel('deepseek-deepsee', 'deepseek-v4-flash')) as {
            provider: string;
            id: string;
            inputModalities: string[];
        };
        expect(info.provider).toBe('deepseek-deepsee');
        expect(info.id).toBe('deepseek-v4-flash');
        expect(info.inputModalities).toEqual(['text', 'image']);
        for await (const _chunk of adapter.stream({
            provider: 'deepseek-deepsee',
            model: 'deepseek-v4-flash',
            messages: [],
        }) as AsyncIterable<unknown>) {
            // drain
        }
        expect(streamed[0].provider).toBe('deepseek-official');
    });

    it('degrades silently without the registration surface or when disabled', async () => {
        await loadWith(undefined);
        const registered: unknown[] = [];
        await loadWith(
            { registerAdapter: (...args: unknown[]) => registered.push(args), stream: () => {} },
            { visionProvider: false },
        );
        expect(registered).toEqual([]);
    });
});

describe('dsh plugin request-time image conversion (v2)', () => {
    it('keeps the log intact and converts wire messages once per attachment', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-dsh-cli-'));
        const marker = path.join(cliDir, 'count');
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'WIRE-EVIDENCE'},uncertainty:[]}}))`,
        );
        process.env.DEEPSEE_DSH_CLI = cli;
        try {
            const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
            const streamed: Array<{
                messages: Array<{ content: Array<{ type: string; text?: string }> }>;
            }> = [];
            const ctx = {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: () => {},
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: (options: never) => {
                        streamed.push(options);
                        return (async function* () {})();
                    },
                },
            };
            plugin.apply(ctx as never, {});
            const adapter = registered[0].adapter;
            const request = {
                provider: 'deepseek-deepsee',
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'what is this' },
                            { type: 'image', attachment: { id: 'att-1' } },
                        ],
                    },
                ],
            };
            for await (const _c of adapter.stream(request) as AsyncIterable<unknown>) {
                // drain
            }
            const wire = streamed[0].messages[0].content;
            expect(wire[0]).toEqual({ type: 'text', text: 'what is this' });
            expect(wire[1].type).toBe('text');
            expect(wire[1].text).toContain('WIRE-EVIDENCE');
            // The caller's request object keeps its image block untouched.
            expect(request.messages[0].content[1].type).toBe('image');
            // Second request with the same attachment hits the cache: one CLI run.
            for await (const _c of adapter.stream(request) as AsyncIterable<unknown>) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it('converts images nested inside tool-result content on the wire (#24)', async () => {
        // dsh's native read_image nests its image block inside tool-result
        // content; the upstream adapter's rejection check recurses, so the
        // conversion must too or the session wedges on its own history.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-dsh-nested-'));
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'NESTED-EVIDENCE'},uncertainty:[]}}))`,
        );
        process.env.DEEPSEE_DSH_CLI = cli;
        try {
            const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
            const streamed: Array<{
                messages: Array<{
                    content: Array<{
                        type: string;
                        text?: string;
                        content?: Array<{ type: string; text?: string }>;
                    }>;
                }>;
            }> = [];
            plugin.apply(
                {
                    tools: { register: () => {} },
                    attachments: {
                        readImage: async () => ({
                            data: new Uint8Array([1]),
                            ref: { mediaType: 'image/png' },
                        }),
                    },
                    on: () => {},
                    llm: {
                        registerAdapter: (
                            _p: string[],
                            adapter: Record<string, CallableFunction>,
                        ) => {
                            registered.push({ adapter });
                        },
                        listModels: async () => [],
                        resolveModelInfo: async () => ({}),
                        stream: (options: never) => {
                            streamed.push(options);
                            return (async function* () {})();
                        },
                    },
                } as never,
                {},
            );
            const request = {
                provider: 'deepseek-deepsee',
                model: 'm',
                messages: [
                    {
                        role: 'tool',
                        content: [
                            {
                                type: 'tool-result',
                                toolCallId: 'call_1',
                                content: [
                                    { type: 'text', text: '<path>shot.png</path>' },
                                    { type: 'image', attachment: { id: 'att-nested' } },
                                ],
                            },
                        ],
                    },
                ],
            };
            for await (const _c of registered[0].adapter.stream(
                request,
            ) as AsyncIterable<unknown>) {
                // drain
            }
            const wire = streamed[0].messages[0].content[0];
            expect(wire.type).toBe('tool-result');
            expect(wire.content?.[0]).toEqual({ type: 'text', text: '<path>shot.png</path>' });
            expect(wire.content?.[1].type).toBe('text');
            expect(wire.content?.[1].text).toContain('NESTED-EVIDENCE');
            // The caller's request keeps the nested image: the log stays native.
            const original = request.messages[0].content[0] as {
                content: Array<{ type: string }>;
            };
            expect(original.content[1].type).toBe('image');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    async function adapterWithCli(cli: string) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: Array<{ adapter: Record<string, CallableFunction> }> = [];
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {
                    readImage: async () => ({
                        data: new Uint8Array([1]),
                        ref: { mediaType: 'image/png' },
                    }),
                },
                on: () => {},
                llm: {
                    registerAdapter: (_p: string[], adapter: Record<string, CallableFunction>) => {
                        registered.push({ adapter });
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        process.env.DEEPSEE_DSH_CLI = cli;
        return registered[0].adapter;
    }

    const imageRequest = (id: string) => ({
        provider: 'deepseek-deepsee',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { id } }] }],
    });

    it('does not memoize a failed read: the next step retries', async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-dsh-retry-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        // First run fails (transient config error), later runs succeed.
        fs.writeFileSync(
            cli,
            `const fs=require('fs');const n=(fs.existsSync(${JSON.stringify(marker)})?fs.readFileSync(${JSON.stringify(marker)},'utf8').length:0)+1;fs.appendFileSync(${JSON.stringify(marker)},'x');
             if(n===1){console.error('quota exhausted');process.exit(1)}
             console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'RECOVERED'},uncertainty:[]}}))`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            for await (const _c of adapter.stream(
                imageRequest('att-r'),
            ) as AsyncIterable<unknown>) {
                // drain
            }
            for await (const _c of adapter.stream(
                imageRequest('att-r'),
            ) as AsyncIterable<unknown>) {
                // drain
            }
            expect(fs.readFileSync(marker, 'utf-8')).toBe('xx');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it("one caller's abort neither kills the other waiter nor the shared read", async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-dsh-abort-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             setTimeout(()=>console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'SURVIVED'},uncertainty:[]}})),200)`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            const controller = new AbortController();
            const cancelled = (async () => {
                for await (const _c of adapter.stream({
                    ...imageRequest('att-a'),
                    signal: controller.signal,
                }) as AsyncIterable<unknown>) {
                    // drain
                }
            })().then(
                () => 'completed',
                () => 'aborted',
            );
            const survivor = (async () => {
                for await (const _c of adapter.stream(
                    imageRequest('att-a'),
                ) as AsyncIterable<unknown>) {
                    // drain
                }
                return 'completed';
            })();
            setTimeout(() => controller.abort(), 30);
            // The cancelled caller stops promptly; the other waiter and the
            // underlying read are unaffected, and the read ran exactly once.
            expect(await cancelled).toBe('aborted');
            expect(await survivor).toBe('completed');
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });

    it('joins concurrent readers of the same attachment into one CLI run', async () => {
        const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-dsh-conc-'));
        const marker = path.join(cliDir, 'runs');
        const cli = path.join(cliDir, 'cli.js');
        // Slow enough that both streams overlap the same in-flight read.
        fs.writeFileSync(
            cli,
            `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');
             setTimeout(()=>console.log(JSON.stringify({result:{summary:'S',ocr:{full_text:'ONCE'},uncertainty:[]}})),150)`,
        );
        try {
            const adapter = await adapterWithCli(cli);
            const drain = async () => {
                for await (const _c of adapter.stream(
                    imageRequest('att-c'),
                ) as AsyncIterable<unknown>) {
                    // drain
                }
            };
            await Promise.all([drain(), drain()]);
            expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
        } finally {
            delete process.env.DEEPSEE_DSH_CLI;
        }
    });
});

describe('dsh plugin tool-name collision (#21)', () => {
    it('falls back to deepsee_read_image and keeps the rest of the plugin alive', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const adapters: string[] = [];
        plugin.apply(
            {
                tools: {
                    register: (tool: { name: string }) => {
                        // The host's native read_image (dsh-tool-fs) is there first.
                        if (tool.name === 'read_image') {
                            throw new Error('tool "read_image" is already registered');
                        }
                        registered.push(tool.name);
                    },
                },
                attachments: {},
                on: () => {},
                llm: {
                    registerAdapter: (providers: string[]) => {
                        adapters.push(...providers);
                    },
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        expect(registered).toContain('deepsee_read_image');
        // The collision no longer fails the fiber: the vision wrapper registered.
        expect(adapters).toContain('deepseek-deepsee');
    });

    it('an unrelated registration error degrades without killing apply', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        expect(() =>
            plugin.apply(
                {
                    tools: {
                        register: () => {
                            throw new Error('registry exploded');
                        },
                    },
                    attachments: {},
                    on: () => {},
                } as never,
                {},
            ),
        ).not.toThrow();
    });
});

describe('image format contract (CLI, skill, dsh in lockstep)', () => {
    it('dsh MEDIA_EXT covers exactly the CLI allow-list', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            MEDIA_EXT: Record<string, string>;
        };
        const { ALLOWED_MIME } = await import('./imageInput.ts');
        expect(new Set(Object.keys(plugin.MEDIA_EXT))).toEqual(ALLOWED_MIME);
    });

    it('the skill trigger extensions are exactly the CLI extension table', async () => {
        const { MIME_BY_EXT } = await import('./imageInput.ts');
        const skill = fs.readFileSync(
            path.join(__dirname, '..', 'skills', 'deepsee', 'SKILL.md'),
            'utf-8',
        );
        const match = skill.match(/\(((?:\.\w+, )+\.\w+)\)/);
        expect(match).toBeTruthy();
        const skillExts = new Set((match as RegExpMatchArray)[1].split(', '));
        expect(skillExts).toEqual(new Set(Object.keys(MIME_BY_EXT)));
    });
});

describe('format mapping lockstep', () => {
    it('every MEDIA_EXT value maps back to its mime through the CLI table', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            MEDIA_EXT: Record<string, string>;
        };
        const { MIME_BY_EXT } = await import('./imageInput.ts');
        for (const [mime, ext] of Object.entries(plugin.MEDIA_EXT)) {
            expect(MIME_BY_EXT[ext]).toBe(mime);
        }
    });
});

describe('dsh paste-to-path host route', () => {
    type RouteHandler = (
        req: {
            method: string;
            [Symbol.asyncIterator]: () => AsyncIterator<Buffer>;
        },
        res: {
            writeHead: (code: number, headers?: Record<string, string>) => unknown;
            end: (body?: string) => void;
        },
    ) => Promise<void>;

    async function routeOf(
        config: Record<string, unknown> = {},
        llm?: unknown,
        events?: Record<string, () => void>,
    ) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const routes: Array<{ path: string; handler: RouteHandler }> = [];
        const scoped = {
            webServer: {
                register: (route: { path: string; handler: RouteHandler }) => routes.push(route),
            },
        };
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                // A listProviders/listModels-only llm: the vision provider
                // registration path feature-detects registerAdapter and backs
                // off, so this reaches exactly the paste policy code.
                ...(llm ? { llm } : {}),
                on: (event: string, fn: () => void) => {
                    if (events) events[event] = fn;
                },
                inject: (deps: string[], fn: (scope: unknown) => void) => {
                    // The scoped closure runs only where webServer exists.
                    if (deps.includes('webServer')) fn(scoped);
                },
            } as never,
            config,
        );
        return routes;
    }

    function fakeReq(method: string, body: Buffer, url = '/deepsee/paste') {
        return {
            method,
            url,
            destroy: () => {},
            async *[Symbol.asyncIterator]() {
                yield body;
            },
        };
    }

    function fakeRes() {
        const out = { code: 0, body: '' };
        return {
            out,
            res: {
                writeHead: (code: number) => {
                    out.code = code;
                    return { end: (b?: string) => (out.body = b ?? '') };
                },
                end: (b?: string) => {
                    out.body = b ?? '';
                },
            },
        };
    }

    it('registers /deepsee/paste under the web profile and writes a private file', async () => {
        const routes = await routeOf();
        expect(routes[0]?.path).toBe('/deepsee/paste');
        const { out, res } = fakeRes();
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
        await routes[0].handler(fakeReq('POST', png) as never, res as never);
        expect(out.code).toBe(200);
        const { path: written } = JSON.parse(out.body) as { path: string };
        expect(written.endsWith('paste.png')).toBe(true);
        expect(fs.readFileSync(written)).toEqual(png);
        // POSIX permission bits are meaningless on Windows (mode reads 0o666
        // regardless), the same boundary recover-paste's checks respect.
        if (process.platform !== 'win32') {
            expect(fs.statSync(written).mode & 0o777).toBe(0o600);
        }
        fs.rmSync(path.dirname(written), { recursive: true, force: true });
    });

    it('refuses non-GET/POST, non-image bytes, and honors the off switch', async () => {
        const routes = await routeOf();
        const a = fakeRes();
        await routes[0].handler(fakeReq('PUT', Buffer.alloc(0)) as never, a.res as never);
        expect(a.out.code).toBe(405);
        const b = fakeRes();
        await routes[0].handler(
            fakeReq('POST', Buffer.from('not an image')) as never,
            b.res as never,
        );
        expect(b.out.code).toBe(400);
        // Disabling paste-to-path leaves the independent DeepSee settings
        // control plane available for keys and Auto/Customize routing.
        expect((await routeOf({ pasteToPath: false })).map((route) => route.path)).toEqual([
            '/deepsee/settings',
        ]);
    });

    it('sniffs to the CLI table: near-miss magic bytes are refused, real brands pass', async () => {
        const routes = await routeOf();
        const post = async (body: Buffer) => {
            const { out, res } = fakeRes();
            await routes[0].handler(fakeReq('POST', body) as never, res as never);
            return out;
        };
        // Generic BMFF: `ftyp` at offset 4 but a video brand. The old sniff
        // accepted any ftyp box and saved plain video as paste.heic.
        const bmff = Buffer.concat([
            Buffer.from([0, 0, 0, 24]),
            Buffer.from('ftypmp42'),
            Buffer.alloc(8),
        ]);
        expect((await post(bmff)).code).toBe(400);
        // A real heif brand still lands, with its own extension.
        const heif = Buffer.concat([
            Buffer.from([0, 0, 0, 24]),
            Buffer.from('ftypmif1'),
            Buffer.alloc(8),
        ]);
        const okHeif = await post(heif);
        expect(okHeif.code).toBe(200);
        const heifPath = (JSON.parse(okHeif.body) as { path: string }).path;
        expect(heifPath.endsWith('paste.heif')).toBe(true);
        fs.rmSync(path.dirname(heifPath), { recursive: true, force: true });
        // Truncated PNG magic (first four bytes only) is not a PNG.
        expect((await post(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).code).toBe(400);
        // "GIF" alone is not a GIF signature; the full GIF89a is.
        expect((await post(Buffer.from('GIFfake'))).code).toBe(400);
        const okGif = await post(Buffer.from('GIF89a '));
        expect(okGif.code).toBe(200);
        const gifPath = (JSON.parse(okGif.body) as { path: string }).path;
        fs.rmSync(path.dirname(gifPath), { recursive: true, force: true });
    });

    it('GET answers the takeover policy from host model metadata, not name guessing', async () => {
        const llm = {
            listProviders: () => [{ id: 'deepseek-official' }, { id: 'qwen' }],
            listModels: async (id: string) =>
                id === 'deepseek-official'
                    ? [
                          {
                              id: 'deepseek-v4-flash',
                              name: 'DeepSeek-V4-Flash',
                              inputModalities: ['text'],
                          },
                      ]
                    : [
                          {
                              id: 'qwen2.5-vl',
                              name: 'Qwen2.5-VL',
                              inputModalities: ['text', 'image'],
                          },
                      ],
        };
        const routes = await routeOf({}, llm);
        const ask = async (label: string) => {
            const { out, res } = fakeRes();
            await routes[0].handler(
                fakeReq(
                    'GET',
                    Buffer.alloc(0),
                    `/deepsee/paste?model=${encodeURIComponent(label)}`,
                ) as never,
                res as never,
            );
            expect(out.code).toBe(200);
            return (JSON.parse(out.body) as { takeover: boolean }).takeover;
        };
        // A text-only model resolved from metadata: take the paste over.
        expect(await ask('选择模型，当前 DeepSeek-V4-Flash，推理等级 High')).toBe(true);
        // A vision model no name heuristic would catch: paste stays native.
        expect(await ask('Select model, current Qwen2.5-VL')).toBe(false);
        // Our own wrapped variant converts at request time: stays native.
        expect(await ask('DeepSeek-V4-Flash (deepsee vision)')).toBe(false);
        // Unresolvable labels fail toward the native paste path.
        expect(await ask('Mystery Model 9000')).toBe(false);
        expect(await ask('')).toBe(false);
    });

    it('one image-capable match vetoes same-name models across providers', async () => {
        // The selector label carries no provider id: when two routes expose
        // the same display name and disagree on modality, the host cannot
        // know which one is selected, so it must refuse the takeover.
        const llm = {
            listProviders: () => [{ id: 'text-route' }, { id: 'vision-route' }],
            listModels: async (id: string) =>
                id === 'text-route'
                    ? [{ id: 'shared-1', name: 'Shared Model', inputModalities: ['text'] }]
                    : [
                          {
                              id: 'shared-2',
                              name: 'Shared Model',
                              inputModalities: ['text', 'image'],
                          },
                      ],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/deepsee/paste?model=${encodeURIComponent('current Shared Model')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('a longer text-only name cannot shadow the selected shorter vision model', async () => {
        // The label's own prose can complete a longer name: with "Select
        // model, current Pro" selected (a vision model named "Pro"), a text
        // route named "Current Pro" also matches — and longest-match used to
        // let it win. Every match must be text-only, so the vision "Pro"
        // vetoes regardless of length.
        const llm = {
            listProviders: () => [{ id: 'vision' }, { id: 'text' }],
            listModels: async (id: string) =>
                id === 'vision'
                    ? [{ id: 'pro-vision', name: 'Pro', inputModalities: ['text', 'image'] }]
                    : [{ id: 'current-pro', name: 'Current Pro', inputModalities: ['text'] }],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/deepsee/paste?model=${encodeURIComponent('Select model, current Pro')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('an unreadable provider catalog vetoes: the vision twin could live there', async () => {
        const llm = {
            listProviders: () => [{ id: 'broken' }, { id: 'text' }],
            listModels: async (id: string) => {
                if (id === 'broken') throw new Error('catalog offline');
                return [{ id: 'shared', name: 'Shared Model', inputModalities: ['text'] }];
            },
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/deepsee/paste?model=${encodeURIComponent('current Shared Model')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('a two-character vision name still vetoes: no length floor on the veto', async () => {
        // A vision model named "AI" appears in "current AI" as legitimately
        // as any long name. A length filter on the veto side let the longer
        // text-only "Current AI" confirm the takeover alone.
        const llm = {
            listProviders: () => [{ id: 'vision' }, { id: 'text' }],
            listModels: async (id: string) =>
                id === 'vision'
                    ? [{ id: 'vision-ai', name: 'AI', inputModalities: ['text', 'image'] }]
                    : [{ id: 'current-ai', name: 'Current AI', inputModalities: ['text'] }],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/deepsee/paste?model=${encodeURIComponent('Select model, current AI')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('a topology change empties the verdict cache, so late twins are seen', async () => {
        // The cache key is only the label. A same-named vision route mounting
        // inside the TTL used to keep serving the pre-mount true; the cache
        // now empties on llm/adapters-updated, the exact boundary that
        // invalidates it.
        const providers = [{ id: 'text' }];
        const models: Record<string, unknown[]> = {
            text: [{ id: 'shared-text', name: 'Shared Model', inputModalities: ['text'] }],
            vision: [
                { id: 'shared-vision', name: 'Shared Model', inputModalities: ['text', 'image'] },
            ],
        };
        const llm = {
            listProviders: () => providers,
            listModels: async (id: string) => models[id],
        };
        const events: Record<string, () => void> = {};
        const routes = await routeOf({}, llm, events);
        const ask = async () => {
            const { out, res } = fakeRes();
            await routes[0].handler(
                fakeReq(
                    'GET',
                    Buffer.alloc(0),
                    `/deepsee/paste?model=${encodeURIComponent('current Shared Model')}`,
                ) as never,
                res as never,
            );
            return (JSON.parse(out.body) as { takeover: boolean }).takeover;
        };
        expect(await ask()).toBe(true);
        providers.push({ id: 'vision' });
        events['llm/adapters-updated']?.();
        expect(await ask()).toBe(false);
    });

    it('a verdict computed under the old topology is never cached or served', async () => {
        // The race the plain clear cannot reach: a GET starts against the
        // pre-mount registry, the vision twin mounts and fires the event
        // while the GET awaits listModels, and the stale true then used to be
        // written into the just-emptied cache and served for a full TTL.
        const textModel = { id: 'shared-text', name: 'Shared Model', inputModalities: ['text'] };
        const visionModel = {
            id: 'shared-vision',
            name: 'Shared Model',
            inputModalities: ['text', 'image'],
        };
        const providers = [{ id: 'text' }];
        let releaseText: (() => void) | undefined;
        let deferOnce = true;
        const llm = {
            listProviders: () => providers.map((provider) => ({ ...provider })),
            listModels: async (id: string) => {
                if (id === 'text' && deferOnce) {
                    deferOnce = false;
                    await new Promise<void>((resolve) => {
                        releaseText = resolve;
                    });
                }
                return id === 'vision' ? [visionModel] : [textModel];
            },
        };
        const events: Record<string, () => void> = {};
        const routes = await routeOf({}, llm, events);
        const ask = async () => {
            const { out, res } = fakeRes();
            await routes[0].handler(
                fakeReq(
                    'GET',
                    Buffer.alloc(0),
                    `/deepsee/paste?model=${encodeURIComponent('current Shared Model')}`,
                ) as never,
                res as never,
            );
            return (JSON.parse(out.body) as { takeover: boolean }).takeover;
        };
        const racing = ask();
        await new Promise((resolve) => setImmediate(resolve));
        expect(releaseText).toBeTypeOf('function');
        providers.push({ id: 'vision' });
        events['llm/adapters-updated']?.();
        releaseText?.();
        // The racing GET recomputes against the new registry and answers
        // false, and later asks stay false: the stale true never lands.
        expect(await racing).toBe(false);
        expect(await ask()).toBe(false);
    });

    it('missing inputModalities means UNKNOWN, never confirmed text-only', async () => {
        const llm = {
            listProviders: () => [{ id: 'p1' }],
            listModels: async () => [{ id: 'vision-pro', name: 'Vision Pro' }],
        };
        const routes = await routeOf({}, llm);
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq(
                'GET',
                Buffer.alloc(0),
                `/deepsee/paste?model=${encodeURIComponent('current Vision Pro')}`,
            ) as never,
            res as never,
        );
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });

    it('GET without an llm surface (or without a match) never takes over', async () => {
        const routes = await routeOf();
        const { out, res } = fakeRes();
        await routes[0].handler(
            fakeReq('GET', Buffer.alloc(0), '/deepsee/paste?model=DeepSeek-V4-Flash') as never,
            res as never,
        );
        expect(out.code).toBe(200);
        expect((JSON.parse(out.body) as { takeover: boolean }).takeover).toBe(false);
    });
});

describe('dsh vision provider auto-discovery (#29)', () => {
    interface FakeProvider {
        id: string;
        name?: string;
        models: Array<{ id: string; name?: string; inputModalities?: string[] }>;
    }

    async function discoveryCtx(providers: FakeProvider[], config: Record<string, unknown> = {}) {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const attempts: string[] = [];
        const handlers: Record<string, () => void> = {};
        const live = [...providers];
        const ctx = {
            tools: { register: () => {} },
            attachments: {},
            on: (event: string, fn: () => void) => {
                handlers[event] = fn;
            },
            llm: {
                registerAdapter: (ids: string[]) => {
                    // Attempts are recorded BEFORE the duplicate check: a
                    // re-entrancy bug shows up as extra attempts even when
                    // the duplicate throw keeps `registered` clean.
                    attempts.push(ids[0]);
                    if (registered.includes(ids[0])) {
                        throw new Error(`adapter "${ids[0]}" is already registered`);
                    }
                    registered.push(...ids);
                    // The real registry broadcasts on every topology commit,
                    // which is exactly what makes sweeps re-enter mid-flight.
                    handlers['llm/adapters-updated']?.();
                },
                listProviders: () => live.map((p) => ({ id: p.id, name: p.name })),
                listModels: async (id: string) => live.find((p) => p.id === id)?.models ?? [],
                resolveModelInfo: async () => ({}),
                stream: () => (async function* () {})(),
            },
        };
        plugin.apply(ctx as never, config);
        // sweep is async; give it a tick.
        await new Promise((r) => setTimeout(r, 10));
        return { registered, attempts, handlers, live };
    }

    const deepseek: FakeProvider = {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash' }],
    };
    const opencode: FakeProvider = {
        id: 'opencode-go',
        name: 'opencode-go',
        models: [{ id: 'glm-5.3' }],
    };
    const unrelated: FakeProvider = {
        id: 'other-vendor',
        models: [{ id: 'kimi-k2.5' }],
    };

    it('wraps every route carrying wrappable family models, exactly once each', async () => {
        const { registered, attempts } = await discoveryCtx([deepseek, opencode, unrelated]);
        // deepseek-official keeps its historical id; others get deepsee-<id>;
        // a route with no family models is left alone. Attempts are counted
        // before the fake's duplicate check and the fake broadcasts on every
        // registration like the real registry, so a re-entrancy bug shows up
        // here as extra ATTEMPTS even when duplicate errors keep the success
        // list clean.
        expect([...registered].sort()).toEqual(['deepsee-opencode-go', 'deepseek-deepsee']);
        expect([...attempts].sort()).toEqual(['deepsee-opencode-go', 'deepseek-deepsee']);
    });

    it('honors the discover whitelist', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode], {
            discover: ['opencode-go'],
        });
        expect(registered).toEqual(['deepsee-opencode-go']);
    });

    it('a set upstream keeps single-route legacy mode', async () => {
        const { registered } = await discoveryCtx([deepseek, opencode], {
            upstream: 'deepseek-official',
        });
        expect(registered).toEqual(['deepseek-deepsee']);
    });

    it('never wraps its own wrappers', async () => {
        const { registered } = await discoveryCtx([
            deepseek,
            { id: 'deepsee-opencode-go', models: [{ id: 'glm-5.3' }] },
        ]);
        expect(registered).toEqual(['deepseek-deepsee']);
    });

    it('late routes are wrapped when the registry notifies', async () => {
        const { registered, handlers, live } = await discoveryCtx([deepseek]);
        expect(registered).toEqual(['deepseek-deepsee']);
        // llm-pi-ai style: a provider registering after plugin mount.
        live.push(opencode);
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toContain('deepsee-opencode-go');
        // And the notification never duplicates existing wraps.
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered.filter((id) => id === 'deepsee-opencode-go')).toHaveLength(1);
    });

    it('notifications landing inside the probe window never double-register', async () => {
        // A deferred listModels holds the first sweep suspended while
        // notifications fire: the claim-before-await plus serialization must
        // keep every id at exactly one registration ATTEMPT, not just one
        // success behind duplicate errors.
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const attempts: string[] = [];
        const handlers: Record<string, () => void> = {};
        let releaseProbe: (models: Array<{ id: string }>) => void = () => {};
        const gate = new Promise<Array<{ id: string }>>((resolve) => {
            releaseProbe = resolve;
        });
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    registerAdapter: (ids: string[]) => {
                        attempts.push(ids[0]);
                        handlers['llm/adapters-updated']?.();
                    },
                    listProviders: () => [{ id: 'opencode-go', name: 'opencode-go' }],
                    listModels: () => gate,
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        // The sweep is now suspended inside listModels. Storm it.
        for (let i = 0; i < 5; i++) {
            handlers['llm/adapters-updated']();
        }
        releaseProbe([{ id: 'glm-5.3' }]);
        await new Promise((r) => setTimeout(r, 30));
        expect(attempts).toEqual(['deepsee-opencode-go']);
    });

    it('a sweep failure is contained, and the next notification recovers', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const attempts: string[] = [];
        const handlers: Record<string, () => void> = {};
        let boom = true;
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    registerAdapter: (ids: string[]) => {
                        attempts.push(ids[0]);
                    },
                    listProviders: () => {
                        if (boom) {
                            throw new Error('registry mid-mutation');
                        }
                        return [{ id: 'opencode-go', name: 'opencode-go' }];
                    },
                    listModels: async () => [{ id: 'glm-5.3' }],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        await new Promise((r) => setTimeout(r, 10));
        // The throwing sweep neither killed the process nor registered.
        expect(attempts).toEqual([]);
        boom = false;
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(attempts).toEqual(['deepsee-opencode-go']);
    });

    it('a route without eligible models is retried when models appear later', async () => {
        const bare: FakeProvider = { id: 'opencode-go', name: 'opencode-go', models: [] };
        const { registered, handlers, live } = await discoveryCtx([bare]);
        expect(registered).toEqual([]);
        live[0].models.push({ id: 'glm-5.3' });
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toEqual(['deepsee-opencode-go']);
    });

    it('the legacy fallback on an old registry surface registers exactly once', async () => {
        // @ts-expect-error untyped on purpose
        const plugin = (await import('../dsh/index.js')) as {
            apply: (ctx: unknown, config?: Record<string, unknown>) => void;
        };
        const registered: string[] = [];
        const handlers: Record<string, () => void> = {};
        plugin.apply(
            {
                tools: { register: () => {} },
                attachments: {},
                on: (event: string, fn: () => void) => {
                    handlers[event] = fn;
                },
                llm: {
                    // No listProviders: the pre-discovery registry surface.
                    registerAdapter: (ids: string[]) => registered.push(...ids),
                    listModels: async () => [],
                    resolveModelInfo: async () => ({}),
                    stream: () => (async function* () {})(),
                },
            } as never,
            {},
        );
        await new Promise((r) => setTimeout(r, 10));
        handlers['llm/adapters-updated']();
        handlers['llm/adapters-updated']();
        await new Promise((r) => setTimeout(r, 10));
        expect(registered).toEqual(['deepseek-deepsee']);
    });
});
