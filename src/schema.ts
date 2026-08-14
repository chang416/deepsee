// JSON schema enforced on the provider via structured output.
// Fields that vision models tend to fabricate (pixel bboxes, numeric
// confidence) are intentionally excluded.
export const VISION_RESULT_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        ocr: {
            type: 'object',
            properties: {
                full_text: { type: 'string' },
                lines: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            text: { type: 'string' },
                            language: { type: 'string' },
                        },
                        required: ['text'],
                    },
                },
            },
            required: ['full_text', 'lines'],
        },
        layout: {
            type: 'object',
            properties: {
                regions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'string',
                                enum: [
                                    'title',
                                    'subtitle',
                                    'paragraph',
                                    'list',
                                    'table',
                                    'chart',
                                    'form',
                                    'code',
                                    'image',
                                    'icon',
                                    'other',
                                ],
                            },
                            reading_order: { type: 'number' },
                            text: { type: 'string' },
                        },
                        required: ['type', 'reading_order', 'text'],
                    },
                },
            },
            required: ['regions'],
        },
        semantics: {
            type: 'object',
            properties: {
                scene: { type: 'string' },
                intent: { type: 'string' },
                entities: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            type: { type: 'string' },
                            evidence: { type: 'string' },
                        },
                        required: ['name', 'type'],
                    },
                },
                relations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            subject: { type: 'string' },
                            predicate: { type: 'string' },
                            object: { type: 'string' },
                        },
                        required: ['subject', 'predicate', 'object'],
                    },
                },
            },
            required: ['scene', 'entities'],
        },
        visual: {
            type: 'object',
            properties: {
                dominant_colors: { type: 'array', items: { type: 'string' } },
                style: { type: 'string' },
                notes: { type: 'array', items: { type: 'string' } },
            },
        },
        uncertainty: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'ocr', 'layout', 'semantics', 'visual', 'uncertainty'],
} as const;

export function visionResultSchemaJson(): string {
    return JSON.stringify(VISION_RESULT_SCHEMA);
}

/**
 * The paths where a result violates the vision contract: absent required
 * fields, wrong types, wrong element types inside arrays, values outside an
 * enum. Empty means the result matches.
 *
 * Server-side schema enforcement only covers some routes (gemini responseSchema,
 * anthropic tool input_schema, agy/claude-cli --json-schema), and even those can
 * hand back a shell that only looks right. This is the portable check the
 * analyzer runs over every provider's result, so a structurally broken payload
 * fails loudly instead of reaching the caller as if it were evidence.
 *
 * The walk is driven by VISION_RESULT_SCHEMA itself, so the provider schema and
 * this runtime check can never disagree: there is one source of truth.
 */
export function missingSchemaFields(result: unknown): string[] {
    return schemaViolations(VISION_RESULT_SCHEMA as JsonSchemaNode, result, '');
}

interface JsonSchemaNode {
    type?: string;
    properties?: Record<string, JsonSchemaNode>;
    required?: readonly string[];
    items?: JsonSchemaNode;
    enum?: readonly string[];
}

function schemaViolations(schema: JsonSchemaNode, value: unknown, path: string): string[] {
    const label = path || '(root)';

    if (schema.type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return [label];
        }
        const record = value as Record<string, unknown>;
        const violations: string[] = [];
        for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
            const childPath = path ? `${path}.${key}` : key;
            const isRequired = schema.required?.includes(key) ?? false;
            if (!(key in record) || record[key] === undefined) {
                if (isRequired) {
                    violations.push(childPath);
                }
                continue;
            }
            // A present field must match its schema whether required or not.
            violations.push(...schemaViolations(childSchema, record[key], childPath));
        }
        return violations;
    }

    if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            return [label];
        }
        if (!schema.items) {
            return [];
        }
        const itemSchema = schema.items;
        return value.flatMap((item, index) =>
            schemaViolations(itemSchema, item, `${path}[${index}]`),
        );
    }

    if (schema.type === 'string') {
        if (typeof value !== 'string') {
            return [label];
        }
        if (schema.enum && !schema.enum.includes(value)) {
            return [label];
        }
        return [];
    }

    if (schema.type === 'number') {
        return typeof value === 'number' && Number.isFinite(value) ? [] : [label];
    }

    return [];
}
