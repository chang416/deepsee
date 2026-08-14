import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

// The browser half (dsh/client.js) is a hand-written script in the
// __ModuleLoader__ bundle protocol — no module exports, browser globals only.
// It is evaluated here with those globals stubbed, which pins the contracts
// no host-route test can see: the capture listener takes a paste over ONLY on
// a host-confirmed text-only verdict, a 404 (route off) stands the client
// down entirely, and the cordis effect removes the listeners.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'dsh', 'client.js'), 'utf-8');

interface FetchCall {
    url: string;
    init?: { method?: string; body?: unknown };
}

interface Harness {
    dispatchPaste: (files: Array<{ type: string }>) => {
        prevented: boolean;
        stopped: boolean;
    };
    focusComposer: () => void;
    settle: () => Promise<void>;
    fetchCalls: FetchCall[];
    insertedText: () => string;
    listeners: () => Record<string, number>;
    dispose: () => void;
    clickText: (text: string) => void;
    setModelLabel: (label: string) => void;
}

function loadClient(options: {
    policy?: (label: string) => { status: number; takeover?: boolean };
    uploadPath?: string;
    postStatus?: number;
}): Harness {
    const fetchCalls: FetchCall[] = [];
    const policy = options.policy ?? (() => ({ status: 200, takeover: false }));
    const uploadPath = options.uploadPath ?? '/tmp/deepsee-test/paste.png';
    const postStatus = options.postStatus ?? 200;

    let modelLabel = '';
    let inserted = '';
    const handlers = new Map<string, Set<(event: unknown) => void>>();
    const addListener = (type: string, fn: (event: unknown) => void) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)?.add(fn);
    };
    const removeListener = (type: string, fn: (event: unknown) => void) => {
        handlers.get(type)?.delete(fn);
    };

    const textarea = {
        tagName: 'TEXTAREA',
        value: '',
        focus: () => {},
        dispatchEvent: () => true,
    };

    const documentStub = {
        addEventListener: addListener,
        removeEventListener: removeListener,
        querySelectorAll: () => [
            {
                getAttribute: () => `Select model, current ${modelLabel}`,
            },
        ],
        activeElement: textarea,
        execCommand: (_cmd: string, _ui: boolean, text: string) => {
            inserted += text;
            return true;
        },
    };

    let disposer: (() => void) | undefined;
    const ctx = {
        effect: (factory: () => () => void) => {
            disposer = factory();
        },
    };

    let loaded: { factory: () => { apply: (ctx: unknown) => void } } | undefined;
    const windowStub = {
        __ModuleLoader__: {
            load: (definition: { factory: () => { apply: (ctx: unknown) => void } }) => {
                loaded = definition;
            },
        },
    };

    const fetchStub = (url: string, init?: { method?: string; body?: unknown }) => {
        fetchCalls.push({ url, init });
        if (init?.method === 'POST') {
            return Promise.resolve({
                ok: postStatus >= 200 && postStatus < 300,
                status: postStatus,
                json: () =>
                    Promise.resolve(
                        postStatus >= 200 && postStatus < 300
                            ? { path: uploadPath }
                            : { error: `gone (${postStatus})` },
                    ),
            });
        }
        const label = decodeURIComponent(url.split('model=')[1] ?? '');
        const verdict = policy(label);
        return Promise.resolve({
            ok: verdict.status >= 200 && verdict.status < 300,
            status: verdict.status,
            json: () => Promise.resolve({ takeover: verdict.takeover === true }),
        });
    };

    // The script only reaches for window, document, fetch, and Event; handing
    // them in as parameters keeps the stubbing exact and the file untouched.
    const run = new Function('window', 'document', 'fetch', 'Event', SOURCE);
    run(windowStub, documentStub, fetchStub, class {});
    if (!loaded) throw new Error('client.js never called __ModuleLoader__.load');
    loaded.factory().apply(ctx);

    return {
        dispatchPaste: (files) => {
            const flags = { prevented: false, stopped: false };
            const event = {
                clipboardData: {
                    items: files.map((file) => ({
                        kind: 'file',
                        getAsFile: () => ({
                            type: file.type,
                            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
                        }),
                    })),
                },
                preventDefault: () => {
                    flags.prevented = true;
                },
                stopImmediatePropagation: () => {
                    flags.stopped = true;
                },
                target: textarea,
            };
            for (const fn of handlers.get('paste') ?? []) fn(event);
            return flags;
        },
        focusComposer: () => {
            for (const fn of handlers.get('focusin') ?? []) fn({});
        },
        settle: async () => {
            // Drain the promise chains the client starts (policy fetch,
            // upload, insert) without real timers.
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }
        },
        fetchCalls,
        insertedText: () => inserted,
        listeners: () => {
            const counts: Record<string, number> = {};
            for (const [type, set] of handlers) counts[type] = set.size;
            return counts;
        },
        dispose: () => disposer?.(),
        clickText: (text) => {
            const target = {
                textContent: text,
                getAttribute: () => '',
                parentElement: null,
            };
            for (const fn of handlers.get('click') ?? []) fn({ target });
        },
        setModelLabel: (label) => {
            modelLabel = label;
        },
    };
}

const IMAGE = [{ type: 'image/png' }];

describe('dsh paste-to-path browser half', () => {
    it('ships visual self-check controls in the in-app settings panel', () => {
        expect(SOURCE).toContain('Gemini visual self-check');
        expect(SOURCE).toContain('Require a PASS before final delivery');
        expect(SOURCE).toContain('Maximum rounds per phase');
        expect(SOURCE).toContain('visualCheck: {');
        expect(SOURCE).toContain("'ui-implementation'");
        expect(SOURCE).toContain("'visual-review'");
    });

    it('takes a paste over only after the host confirms a text-only model', async () => {
        const harness = loadClient({
            policy: (label) => ({ status: 200, takeover: label.includes('DeepSeek') }),
        });
        harness.setModelLabel('DeepSeek-V4-Flash');

        // First paste: no cached verdict yet — stays native, kicks the fetch.
        const first = harness.dispatchPaste(IMAGE);
        expect(first.prevented).toBe(false);
        await harness.settle();

        // Second paste: verdict cached true — taken over, uploaded, inserted.
        const second = harness.dispatchPaste(IMAGE);
        expect(second.prevented).toBe(true);
        expect(second.stopped).toBe(true);
        await harness.settle();
        expect(harness.insertedText()).toContain('/tmp/deepsee-test/paste.png');
        const posts = harness.fetchCalls.filter((call) => call.init?.method === 'POST');
        expect(posts).toHaveLength(1);
    });

    it('never takes over when the host says the model reads images itself', async () => {
        const harness = loadClient({ policy: () => ({ status: 200, takeover: false }) });
        harness.setModelLabel('Qwen2.5-VL');
        harness.focusComposer();
        await harness.settle();
        const paste = harness.dispatchPaste(IMAGE);
        expect(paste.prevented).toBe(false);
        await harness.settle();
        expect(harness.insertedText()).toBe('');
        expect(harness.fetchCalls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
    });

    it('stands down entirely when the route is off (404): no takeover, no more requests', async () => {
        const harness = loadClient({ policy: () => ({ status: 404 }) });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const before = harness.fetchCalls.length;
        const paste = harness.dispatchPaste(IMAGE);
        expect(paste.prevented).toBe(false);
        await harness.settle();
        // The 404 marked the route unavailable: later pastes neither take
        // over nor keep polling the dead endpoint.
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
        await harness.settle();
        expect(harness.fetchCalls.length).toBe(before);
        expect(harness.insertedText()).toBe('');
    });

    it('pastes inside the failure round-trip window are the bounded loss', async () => {
        // Two pastes fired before the 404 settles are both taken (the
        // documented window: one local round-trip); once the failure lands,
        // the client stands down and later pastes go native with no requests.
        const harness = loadClient({
            policy: () => ({ status: 200, takeover: true }),
            postStatus: 404,
        });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const first = harness.dispatchPaste(IMAGE);
        const second = harness.dispatchPaste(IMAGE);
        expect(first.prevented).toBe(true);
        expect(second.prevented).toBe(true);
        await harness.settle();
        const before = harness.fetchCalls.length;
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
        await harness.settle();
        expect(harness.fetchCalls.length).toBe(before);
    });

    it('a POST 404 after a confirmed verdict stands the client down for good', async () => {
        // The route can vanish between the policy GET and the paste (plugin
        // disposed mid-session). That race costs at most the one in-flight
        // paste; afterwards every verdict is forgotten and pastes go native.
        const harness = loadClient({
            policy: () => ({ status: 200, takeover: true }),
            postStatus: 404,
        });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const swallowed = harness.dispatchPaste(IMAGE);
        expect(swallowed.prevented).toBe(true);
        await harness.settle();
        expect(harness.insertedText()).toBe('');
        const before = harness.fetchCalls.length;
        const next = harness.dispatchPaste(IMAGE);
        expect(next.prevented).toBe(false);
        await harness.settle();
        expect(harness.fetchCalls.length).toBe(before);
    });

    it('a verdict past its hard age bound is unknown again, not reused', async () => {
        vi.useFakeTimers();
        try {
            const harness = loadClient({ policy: () => ({ status: 200, takeover: true }) });
            harness.setModelLabel('DeepSeek-V4-Flash');
            harness.focusComposer();
            await harness.settle();
            // Fresh verdict: the takeover works.
            expect(harness.dispatchPaste(IMAGE).prevented).toBe(true);
            await harness.settle();
            // 61s later the cached true is stale: the model behind this label
            // may have changed, so the paste stays native until reconfirmed.
            vi.advanceTimersByTime(61_000);
            expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a host verdict flip reaches the client within one round-trip', async () => {
        // Every focus and paste re-asks the host, so when the model behind an
        // unchanged label turns image-capable (a same-named route mounting),
        // at most the one paste racing the refresh is taken; the next goes
        // native.
        let takeover = true;
        const harness = loadClient({ policy: () => ({ status: 200, takeover }) });
        harness.setModelLabel('Shared Model');
        harness.focusComposer();
        await harness.settle();
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(true);
        await harness.settle();
        takeover = false;
        // This paste still rides the cached true (the documented round-trip
        // window) and triggers the refresh that flips it.
        harness.dispatchPaste(IMAGE);
        await harness.settle();
        expect(harness.dispatchPaste(IMAGE).prevented).toBe(false);
    });

    it('ignores pastes with no image files', async () => {
        const harness = loadClient({ policy: () => ({ status: 200, takeover: true }) });
        harness.setModelLabel('DeepSeek-V4-Flash');
        harness.focusComposer();
        await harness.settle();
        const paste = harness.dispatchPaste([{ type: 'text/plain' }]);
        expect(paste.prevented).toBe(false);
    });

    it('checks onboarding the first time DeepSee Customize is selected', async () => {
        const harness = loadClient({});
        harness.clickText('DeepSee Customize · Your routing');
        await harness.settle();
        expect(harness.fetchCalls.some((call) => call.url === '/deepsee/settings')).toBe(true);
    });

    it('the cordis effect removes all listeners on disposal', () => {
        const harness = loadClient({});
        expect(harness.listeners().paste).toBe(1);
        expect(harness.listeners().focusin).toBe(1);
        harness.dispose();
        expect(harness.listeners().paste).toBe(0);
        expect(harness.listeners().focusin).toBe(0);
        expect(harness.listeners().click).toBe(0);
    });
});
