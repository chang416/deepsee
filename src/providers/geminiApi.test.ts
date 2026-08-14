import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeGeminiApi } from './geminiApi.ts';

const structured = { summary: 'ok', uncertainty: [] };
let tmpImage: string;

beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-gem-'));
    tmpImage = path.join(dir, 'x.png');
    fs.writeFileSync(tmpImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('executeGeminiApi', () => {
    it('demands an api key up front', async () => {
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: {},
            }),
        ).rejects.toThrow('GEMINI_API_KEY');
    });

    it('builds a generateContent call with responseJsonSchema and parses the output', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                    usageMetadata: { totalTokenCount: 9 },
                }),
                { status: 200 },
            );
        });

        const parsed = await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'AIzaTest' },
        });

        expect(calls[0].url).toContain('/v1beta/models/gemini-flash-latest:generateContent');
        const body = JSON.parse(String(calls[0].init.body));
        expect(body.generationConfig.responseJsonSchema.required).toContain('summary');
        expect(body.contents[0].parts[0].inline_data.data).toBe(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
        );
        expect(parsed.result).toEqual(structured);
        expect(parsed.meta.usage).toEqual({ totalTokenCount: 9 });
    });

    it('adds an extraBody thinking knob while keeping schema enforcement', async () => {
        const calls: Array<{ init: RequestInit }> = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            calls.push({ init });
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                }),
                { status: 200 },
            );
        });

        await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: {
                apiKey: 'AIzaTest',
                extraBody: { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } },
            },
        });

        const body = JSON.parse(String(calls[0].init.body));
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
        expect(body.generationConfig.responseJsonSchema.required).toContain('summary');
    });

    it('surfaces api errors with status and body', async () => {
        vi.stubGlobal('fetch', async () => new Response('quota exceeded', { status: 429 }));
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'AIzaTest' },
            }),
        ).rejects.toThrow('Gemini API error 429');
    });

    it('rotates to the next key on credential/quota responses in order', async () => {
        const calls: string[] = [];
        let attempt = 0;
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            calls.push(headers['x-goog-api-key']);
            attempt += 1;
            if (attempt === 1) {
                return new Response('first key quota exceeded', { status: 429 });
            }
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                }),
                { status: 200 },
            );
        });

        const parsed = await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKeys: [' first-key ', 'first-key', 'second-key'] },
        });

        expect(parsed.result).toEqual(structured);
        expect(calls).toEqual(['first-key', 'second-key']);
    });

    it('does not rotate on an ordinary 4xx request error', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            calls.push(headers['x-goog-api-key']);
            return new Response('invalid request body for first-key', { status: 400 });
        });

        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKeys: ['first-key', 'second-key'] },
            }),
        ).rejects.toThrow('Gemini API error 400');
        expect(calls).toEqual(['first-key']);
    });

    it('rotates on an explicitly quota-labelled 400 response', async () => {
        const calls: string[] = [];
        let attempt = 0;
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            calls.push(headers['x-goog-api-key']);
            attempt += 1;
            if (attempt === 1) {
                return new Response('RESOURCE_EXHAUSTED: quota exceeded', { status: 400 });
            }
            return new Response(
                JSON.stringify({
                    candidates: [{ content: { parts: [{ text: JSON.stringify(structured) }] } }],
                }),
                { status: 200 },
            );
        });

        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKeys: ['first-key', 'second-key'] },
            }),
        ).resolves.toMatchObject({ result: structured });
        expect(calls).toEqual(['first-key', 'second-key']);
    });

    it('redacts every configured key from exhausted-key errors', async () => {
        const firstKey = 'AIzaFirstSecretValue123456789';
        const secondKey = 'AIzaSecondSecretValue987654321';
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(`quota exhausted for ${firstKey}; also tried ${secondKey}`, {
                    status: 429,
                }),
        );

        let error: unknown;
        try {
            await executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKeys: [firstKey, secondKey] },
            });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Gemini API error 429');
        expect((error as Error).message).not.toContain(firstKey);
        expect((error as Error).message).not.toContain(secondKey);
    });

    it('redacts a key echoed by a transport error without rotating on it', async () => {
        const firstKey = 'transport-first-key';
        const secondKey = 'transport-second-key';
        let calls = 0;
        vi.stubGlobal('fetch', async () => {
            calls += 1;
            throw new Error(`transport failed while using ${firstKey}`);
        });

        let error: unknown;
        try {
            await executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKeys: [firstKey, secondKey] },
            });
        } catch (caught) {
            error = caught;
        }
        expect(calls).toBe(1);
        expect((error as Error).message).not.toContain(firstKey);
        expect((error as Error).message).not.toContain(secondKey);
    });

    it('keeps the host fetch in charge when no proxy is configured (#23)', async () => {
        // The proxy path uses undici's own fetch (same-sourced dispatcher),
        // so the global stub below being hit proves the direct path; the
        // proxied path is covered end-to-end in main.test.ts.
        let hits = 0;
        vi.stubGlobal('fetch', async () => {
            hits += 1;
            return new Response('{}', { status: 500 });
        });
        await executeGeminiApi({
            imageSource: tmpImage,
            imageKind: 'local',
            timeoutMs: 5000,
            settings: { apiKey: 'AIzaTest' },
        }).catch(() => {});
        expect(hits).toBe(1);
    });

    it('turns a connect failure into the proxy hint instead of bare fetch failed (#20)', async () => {
        vi.stubGlobal('fetch', async () => {
            throw new TypeError('fetch failed', {
                cause: Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
            });
        });
        await expect(
            executeGeminiApi({
                imageSource: tmpImage,
                imageKind: 'local',
                timeoutMs: 5000,
                settings: { apiKey: 'AIzaTest' },
            }),
        ).rejects.toThrow(/HTTPS_PROXY/);
    });
});
