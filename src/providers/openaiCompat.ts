// OpenAI-compatible provider: works with any /chat/completions endpoint that
// accepts image_url content (DashScope qwen-vl, OpenAI, GLM, ...). No portable
// schema enforcement across vendors, so the schema rides in the prompt and the
// response goes through tolerant JSON extraction.
import { readLocalImageBase64 } from '../imageInput.ts';
import { apiFetch } from '../net/proxy.ts';
import { buildVisionPrompt, JSON_TEMPLATE_INSTRUCTION } from '../prompt.ts';
import { missingSchemaFields } from '../schema.ts';
import { mergeExtraBody } from '../util/extraBody.ts';
import { extractJson, truncate } from '../util/json.ts';
import { redactSecrets } from '../util/redact.ts';
import type {
    BuildProviderInvocationOptions,
    ProviderParsedOutput,
    VisionProvider,
} from './index.ts';

export async function executeOpenaiCompat(
    options: BuildProviderInvocationOptions,
): Promise<ProviderParsedOutput> {
    const apiKey = options.settings?.apiKey;
    const baseUrl = options.settings?.baseUrl?.replace(/\/$/, '');
    const model = options.model || options.settings?.model;

    if (!apiKey || !baseUrl || !model) {
        throw new Error(
            'openai provider needs baseUrl, apiKey, and model. Set OPENAI_BASE_URL and OPENAI_API_KEY, or run: deepsee config set openai.baseUrl <url> / openai.apiKey <key> / openai.model <name>',
        );
    }

    const imageUrl =
        options.imageKind === 'remote'
            ? options.imageSource
            : toDataUrl(readLocalImageBase64(options.imageSource));

    const prompt = `${buildVisionPrompt({
        imageSource: options.imageSource,
        imageKind: 'inline',
        extraPrompt: options.extraPrompt,
    })}

${JSON_TEMPLATE_INSTRUCTION}`;

    const startedAt = Date.now();
    const response = await apiFetch(
        `${baseUrl}/chat/completions`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(
                mergeExtraBody(
                    {
                        model,
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    { type: 'image_url', image_url: { url: imageUrl } },
                                    { type: 'text', text: prompt },
                                ],
                            },
                        ],
                    },
                    options.settings?.extraBody,
                    ['model', 'messages', 'stream'],
                    'openai',
                ),
            ),
            signal: AbortSignal.timeout(options.timeoutMs),
        },
        options.settings?.proxy,
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `OpenAI-compatible API error ${response.status}: ${truncate(redactSecrets(body, [apiKey]))}`,
        );
    }

    const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
    };

    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('OpenAI-compatible API returned no message content.');
    }

    const result = extractJson(text);
    if (result === null) {
        throw new Error(`OpenAI-compatible API returned non-JSON output: ${truncate(text)}`);
    }
    // No portable server-side schema enforcement on this route, so verify the
    // shape instead of silently returning something that only looks right.
    // Checking only top-level keys still let {"ocr":{}} through, so the model
    // received an empty shell that looked like evidence.
    const missing = missingSchemaFields(result);
    if (missing.length > 0) {
        throw new Error(
            `OpenAI-compatible API returned JSON that does not match the vision schema (missing: ${missing.join(', ')}). Retry, or switch to gemini-api / anthropic for enforced schemas. Got: ${truncate(text)}`,
        );
    }

    return {
        result,
        meta: {
            conversationId: null,
            durationSeconds: (Date.now() - startedAt) / 1000,
            usage: payload.usage ?? null,
        },
    };
}

function toDataUrl(image: { data: string; mimeType: string }): string {
    return `data:${image.mimeType};base64,${image.data}`;
}

export const openaiCompatProvider: VisionProvider = {
    name: 'openai',
    defaultModel: '',
    execute: executeOpenaiCompat,
};
