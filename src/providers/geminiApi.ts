// Gemini Developer API provider: direct generateContent call with a free
// AI Studio key. Structured output enforced via responseJsonSchema.
import { fetchRemoteImageBase64, readLocalImageBase64 } from '../imageInput.ts';
import { apiFetch } from '../net/proxy.ts';
import { buildVisionPrompt } from '../prompt.ts';
import { VISION_RESULT_SCHEMA } from '../schema.ts';
import { mergeExtraBody } from '../util/extraBody.ts';
import { truncate } from '../util/json.ts';
import { redactSecrets } from '../util/redact.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderParsedOutput,
    VisionProvider,
} from './index.ts';

export const GEMINI_API_DEFAULT_MODEL = 'gemini-flash-latest';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

export async function executeGeminiApi(
    options: BuildProviderInvocationOptions,
): Promise<ProviderParsedOutput> {
    const apiKeys = normalizeGeminiApiKeys(options.settings?.apiKeys, options.settings?.apiKey);
    if (apiKeys.length === 0) {
        throw new Error(
            'gemini-api provider needs an API key. Set GEMINI_API_KEY, or run: deepsee config set gemini-api.apiKey <key> (free key: https://aistudio.google.com)',
        );
    }

    const model = options.model || options.settings?.model || GEMINI_API_DEFAULT_MODEL;
    const baseUrl = (options.settings?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

    const image =
        options.imageKind === 'remote'
            ? await fetchRemoteImageBase64(options.imageSource, options.timeoutMs)
            : readLocalImageBase64(options.imageSource);

    const prompt = buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: 'inline',
        extraPrompt: options.extraPrompt,
    });

    const requestBody = JSON.stringify(
        mergeExtraBody(
            {
                contents: [
                    {
                        parts: [
                            {
                                inline_data: {
                                    mime_type: image.mimeType,
                                    data: image.data,
                                },
                            },
                            { text: prompt },
                        ],
                    },
                ],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: VISION_RESULT_SCHEMA,
                },
            },
            options.settings?.extraBody,
            [
                'contents',
                'generationConfig.responseMimeType',
                'generationConfig.responseJsonSchema',
            ],
            'gemini-api',
        ),
    );

    const startedAt = Date.now();
    let lastError: unknown;
    for (let index = 0; index < apiKeys.length; index += 1) {
        const apiKey = apiKeys[index];
        try {
            return await executeGeminiRequest({
                options,
                apiKey,
                apiKeys,
                model,
                baseUrl,
                requestBody,
                startedAt,
            });
        } catch (error) {
            lastError = error;
            // A malformed request, a model/content error, a network failure,
            // or a server error is not key-specific: surface it immediately.
            // Only credential/quota/rate-limit responses are safe to retry with
            // another key, and only when one remains.
            if (!isGeminiKeyRotationError(error) || index === apiKeys.length - 1) {
                throw error;
            }
        }
    }

    // The loop always returns or throws. Keep a typed fallback for defensive
    // completeness if that invariant changes in a future edit.
    throw lastError instanceof Error ? lastError : new Error('Gemini API request failed.');
}

interface GeminiRequestOptions {
    options: BuildProviderInvocationOptions;
    apiKey: string;
    apiKeys: string[];
    model: string;
    baseUrl: string;
    requestBody: string;
    startedAt: number;
}

class GeminiApiResponseError extends Error {
    readonly status: number;
    readonly body: string;

    constructor(status: number, body: string) {
        super(`Gemini API error ${status}: ${body}`);
        this.name = 'GeminiApiResponseError';
        this.status = status;
        this.body = body;
    }
}

async function executeGeminiRequest({
    options,
    apiKey,
    apiKeys,
    model,
    baseUrl,
    requestBody,
    startedAt,
}: GeminiRequestOptions): Promise<ProviderParsedOutput> {
    let response: Response;
    try {
        response = await apiFetch(
            `${baseUrl}/v1beta/models/${model}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'x-goog-api-key': apiKey,
                    'Content-Type': 'application/json',
                },
                body: requestBody,
                signal: AbortSignal.timeout(options.timeoutMs),
            },
            options.settings?.proxy,
        );
    } catch (error) {
        // Network/proxy errors are not key-rotation candidates, but a mocked
        // gateway or a lower-level client can still echo a credential in its
        // message. Keep the surfaced error safe before handing it upward.
        const message = error instanceof Error ? error.message : String(error);
        const redacted = redactGeminiText(message, apiKeys);
        if (redacted !== message) {
            throw new Error(redacted);
        }
        throw error;
    }

    if (!response.ok) {
        const body = redactGeminiText(await response.text(), apiKeys);
        throw new GeminiApiResponseError(response.status, truncate(body));
    }

    const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: unknown;
    };

    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
    if (!text) {
        throw new Error('Gemini API returned no text candidate.');
    }

    let result: unknown;
    try {
        result = JSON.parse(text);
    } catch {
        throw new Error(
            `Gemini API returned non-JSON output: ${truncate(redactGeminiText(text, apiKeys))}`,
        );
    }

    return {
        result,
        meta: {
            conversationId: null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usageMetadata ?? null,
        },
    };
}

/**
 * Select the plural key list when it has entries, otherwise retain the legacy
 * single key. The array is ordered and de-duplicated before any request runs.
 */
function normalizeGeminiApiKeys(apiKeys: unknown, apiKey: unknown): string[] {
    const plural = normalizeGeminiKeyInput(apiKeys);
    if (plural.length > 0) {
        return plural;
    }
    return normalizeGeminiKeyInput(apiKey);
}

function normalizeGeminiKeyInput(value: unknown): string[] {
    const candidates: string[] = [];
    const visit = (item: unknown): void => {
        if (typeof item === 'string') {
            const trimmed = item.trim();
            if (trimmed.startsWith('[')) {
                try {
                    const parsed: unknown = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) {
                        visit(parsed);
                        return;
                    }
                } catch {
                    // Keep malformed JSON-looking input as delimiter text;
                    // key normalization should not make provider execution
                    // throw before it can report a missing/invalid key.
                }
            }
            candidates.push(...item.split(/[\r\n,]+/));
        } else if (Array.isArray(item)) {
            for (const nested of item) {
                visit(nested);
            }
        }
    };
    visit(value);

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const candidate of candidates) {
        const key = candidate.trim();
        if (key && !seen.has(key)) {
            seen.add(key);
            normalized.push(key);
        }
    }
    return normalized;
}

function isGeminiKeyRotationError(error: unknown): boolean {
    if (!(error instanceof GeminiApiResponseError)) {
        return false;
    }
    if (error.status === 401 || error.status === 403 || error.status === 429) {
        return true;
    }
    // Some gateways encode quota exhaustion as a 400 RESOURCE_EXHAUSTED
    // response. Restrict body matching to 4xx responses so a generic 500 does
    // not cause blind key rotation, and require an explicit quota/throttling
    // marker rather than treating every client error as key-specific.
    return (
        error.status >= 400 &&
        error.status < 500 &&
        /(?:quota|resource[\s_-]*exhausted|rate[\s_-]*limit(?:[\s_-]*exceeded|ed)?|too many requests|throttl)/i.test(
            error.body,
        )
    );
}

function redactGeminiText(text: string, apiKeys: ReadonlyArray<string>): string {
    let redacted = redactSecrets(text, apiKeys);
    // redactSecrets intentionally skips very short known secrets to avoid
    // tearing ordinary prose. A provider error must never echo even a test or
    // development key, so replace every non-empty exact key here as a final
    // provider-local net.
    for (const apiKey of apiKeys) {
        if (apiKey) {
            redacted = redacted.split(apiKey).join('[redacted]');
        }
    }
    return redacted;
}

export const geminiApiProvider: VisionProvider = {
    name: 'gemini-api',
    defaultModel: GEMINI_API_DEFAULT_MODEL,
    execute: executeGeminiApi,
};
