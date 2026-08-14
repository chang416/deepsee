import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GuardsConfig } from './guard/rules.ts';
import { providerAliases } from './providers/index.ts';
import { parseExtraBody } from './util/extraBody.ts';
import { parseJsonOrExplain } from './util/json.ts';
import { maskUrlCredentials } from './util/redact.ts';

// Layered configuration: CLI flags > environment variables > ~/.deepsee/config.json > built-ins.

export interface ProviderSettings {
    /**
     * Legacy single-key field. Gemini settings also expose `apiKeys`; when
     * both are present, the first normalized `apiKeys` entry is authoritative
     * and is mirrored here so older consumers remain compatible.
     */
    apiKey?: string;
    /** Ordered API keys used by providers that support key rotation (Gemini). */
    apiKeys?: string[];
    baseUrl?: string;
    model?: string;
    /**
     * Proxy URL for this provider's API requests (issue #20). Falls back to
     * the top-level `proxy`, then to HTTPS_PROXY/HTTP_PROXY. Never applies to
     * the SSRF-guarded remote-image download path.
     */
    proxy?: string;
    /**
     * Vendor-specific fields merged into the request body of the API providers
     * (turning thinking off is the usual reason). Not a string like the rest,
     * so the string-only fields have their own type below.
     */
    extraBody?: Record<string, unknown>;
}

/** The settings that hold a plain string, the only ones env vars can bind to. */
export type ProviderStringField = 'apiKey' | 'baseUrl' | 'model' | 'proxy';

const STRING_FIELDS: ProviderStringField[] = ['apiKey', 'baseUrl', 'model', 'proxy'];

/** Harnesses whose local logins deepsee can be granted to borrow. */
export const REUSE_HARNESSES = ['claude', 'codex', 'opencode', 'pi', 'grok'] as const;
export type ReuseHarness = (typeof REUSE_HARNESSES)[number];

export interface DeepseeConfig {
    provider?: string;
    /** Default proxy URL for all API providers (see ProviderSettings.proxy). */
    proxy?: string;
    providers?: Record<string, ProviderSettings>;
    /** Invocation guard: when the active model already sees images, skip the engine. */
    guards?: GuardsConfig;
    /**
     * Per-harness borrow decisions, written by the onboarding conversation:
     * true = the user allowed borrowing this harness's login for reads,
     * false = they refused (do not ask again), absent = never asked.
     * `claude` absent counts as granted for compatibility: claude-cli predates
     * this model as a built-in provider.
     */
    reuse?: Partial<Record<ReuseHarness, boolean>>;
}

export const CONFIG_DIR = path.join(os.homedir(), '.deepsee');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const ENV_BINDINGS: Record<string, Partial<Record<ProviderStringField, string>>> = {
    'gemini-api': { apiKey: 'GEMINI_API_KEY' },
    openai: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    anthropic: { apiKey: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
};

const GEMINI_API_KEYS_ENV = 'GEMINI_API_KEYS';
const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

/**
 * Normalize keys supplied by config or an environment variable. The plural
 * environment form deliberately accepts both comma and newline separators so
 * a settings UI can pass one key per line while shells can use `a,b`.
 * Ordering is retained and duplicate/blank entries are removed.
 */
export function normalizeApiKeys(value: unknown): string[] {
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
                    // Treat a malformed JSON-looking value as delimiter text;
                    // the same normalization still gives callers a safe,
                    // deterministic result instead of throwing from env read.
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

export function loadConfigFile(configPath = CONFIG_PATH): DeepseeConfig {
    let raw: string;
    try {
        raw = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
        // Only a missing file means "no config". Permissions or a directory in
        // its place are real problems, not a reason to fall back to defaults.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw new Error(
            `Cannot read ${configPath}: ${(error as Error).message}. Fix the file or its permissions.`,
        );
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return parsed as DeepseeConfig;
    } catch (error) {
        throw new Error(
            `Failed to parse ${configPath}: ${(error as Error).message}. Fix or delete the file.`,
        );
    }
}

export function defaultProviderName(config: DeepseeConfig): string {
    return config.provider?.trim() || 'antigravity-cli';
}

/** Resolve settings for one provider with env vars overriding the config file. */
export function resolveProviderSettings(
    providerName: string,
    config: DeepseeConfig,
    env: NodeJS.ProcessEnv = process.env,
): ProviderSettings {
    const canonicalProviderName = providerAliases()[providerName] ?? providerName;
    // Settings saved under an alias (config set gemini.apiKey) were invisible
    // once the name resolved to its canonical form.
    const aliasNames = Object.entries(providerAliases())
        .filter(
            ([alias, canonical]) => canonical === canonicalProviderName && alias !== providerName,
        )
        .map(([alias]) => alias);
    const fromFile = {
        ...Object.assign({}, ...aliasNames.map((alias) => config.providers?.[alias] ?? {})),
        ...(config.providers?.[providerName] ?? {}),
    };
    const bindings = ENV_BINDINGS[canonicalProviderName] ?? {};

    const settings: ProviderSettings = { ...fromFile };
    // The top-level proxy is the default; a provider-level one overrides it.
    if (!settings.proxy && config.proxy?.trim()) {
        settings.proxy = config.proxy.trim();
    }
    for (const [field, envName] of Object.entries(bindings) as Array<
        [ProviderStringField, string]
    >) {
        const value = env[envName]?.trim();
        if (value) {
            settings[field] = value;
        }
    }

    if (canonicalProviderName === 'gemini-api') {
        // Explicit plural env input wins over singular env input, which wins
        // over the plural config field, which wins over legacy apiKey. An
        // empty/whitespace-only plural value is treated as absent so a valid
        // singular key is not accidentally disabled.
        const envKeys = normalizeApiKeys(env[GEMINI_API_KEYS_ENV]);
        const envLegacyKeys = normalizeApiKeys(env[GEMINI_API_KEY_ENV]);
        const fileKeys = normalizeApiKeys(fromFile.apiKeys);
        const fileLegacyKeys = normalizeApiKeys(fromFile.apiKey);
        const keys =
            envKeys.length > 0
                ? envKeys
                : envLegacyKeys.length > 0
                  ? envLegacyKeys
                  : fileKeys.length > 0
                    ? fileKeys
                    : fileLegacyKeys;

        if (keys.length > 0) {
            settings.apiKeys = keys;
            // Keep the first key mirrored in the legacy field. Existing
            // readiness checks and callers that only understand apiKey then
            // continue to work while the Gemini provider rotates apiKeys.
            settings.apiKey = keys[0];
        } else {
            delete settings.apiKeys;
        }
    }
    return settings;
}

/** Set a dotted key like "gemini-api.apiKey" or "provider" and persist with 0600 perms. */
export function setConfigValue(dottedKey: string, value: string, configPath = CONFIG_PATH): void {
    const config = loadConfigFile(configPath);

    if (dottedKey === 'provider') {
        config.provider = value;
    } else if (dottedKey === 'proxy') {
        if (value.trim() === '') {
            delete config.proxy;
        } else {
            config.proxy = value.trim();
        }
    } else if (dottedKey.startsWith('reuse.')) {
        const harness = dottedKey.slice('reuse.'.length);
        if (!(REUSE_HARNESSES as readonly string[]).includes(harness)) {
            throw new Error(
                `Unknown reuse harness: ${harness}. Use ${REUSE_HARNESSES.join(', ')}.`,
            );
        }
        const key = harness as ReuseHarness;
        const normalized = value.trim().toLowerCase();
        if (normalized === '') {
            delete config.reuse?.[key];
            if (config.reuse && Object.keys(config.reuse).length === 0) {
                delete config.reuse;
            }
        } else if (normalized !== 'true' && normalized !== 'false') {
            throw new Error(`reuse.${harness} must be true or false (empty clears).`);
        } else {
            config.reuse ??= {};
            config.reuse[key] = normalized === 'true';
        }
    } else if (dottedKey.startsWith('guards.')) {
        setGuardsValue(config, dottedKey.slice('guards.'.length), value);
    } else {
        const dot = dottedKey.indexOf('.');
        if (dot <= 0 || dot === dottedKey.length - 1) {
            throw new Error(
                `Invalid config key: ${dottedKey}. Use "provider", "reuse.<claude|codex|opencode|pi|grok>", "guards.<denyModels|allowModels|denyWhenUnknown>", or "<provider>.<apiKey|apiKeys|baseUrl|model|extraBody>".`,
            );
        }
        const providerName = dottedKey.slice(0, dot);
        const field = dottedKey.slice(dot + 1);
        if (field === 'apiKeys') {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            // A blank value clears the rotation list. Otherwise accept the
            // same comma/newline format as GEMINI_API_KEYS and persist the
            // normalized array, not a delimiter-dependent string.
            const keys = normalizeApiKeys(value);
            if (keys.length === 0) {
                delete config.providers[providerName].apiKeys;
            } else {
                config.providers[providerName].apiKeys = keys;
            }
        } else if (field === 'extraBody') {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            // An empty value clears it, so a user who no longer wants the
            // passthrough does not have to hand-edit the file.
            if (value.trim() === '') {
                delete config.providers[providerName].extraBody;
            } else {
                config.providers[providerName].extraBody = parseExtraBody(
                    value,
                    `${providerName}.extraBody`,
                );
            }
        } else if (!STRING_FIELDS.includes(field as ProviderStringField)) {
            throw new Error(
                `Unknown config field: ${field}. Use apiKey, apiKeys, baseUrl, model, proxy, or extraBody.`,
            );
        } else {
            config.providers ??= {};
            config.providers[providerName] ??= {};
            config.providers[providerName][field as ProviderStringField] = value;
        }
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

/** Accepts a JSON array of globs or a comma-separated list. Empty clears. */
function setGuardsValue(config: DeepseeConfig, field: string, value: string): void {
    if (field === 'denyModels' || field === 'allowModels') {
        if (value.trim() === '') {
            delete config.guards?.[field];
        } else {
            config.guards ??= {};
            config.guards[field] = parseModelList(value, `guards.${field}`);
        }
    } else if (field === 'denyWhenUnknown') {
        const normalized = value.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
            throw new Error('guards.denyWhenUnknown must be true or false.');
        }
        config.guards ??= {};
        config.guards.denyWhenUnknown = normalized === 'true';
    } else {
        throw new Error(
            `Unknown guards field: ${field}. Use denyModels, allowModels, or denyWhenUnknown.`,
        );
    }
    if (config.guards && Object.keys(config.guards).length === 0) {
        delete config.guards;
    }
}

function parseModelList(value: string, key: string): string[] {
    if (value.trim().startsWith('[')) {
        const parsed = parseJsonOrExplain(value, key);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error(`${key} must be a JSON array of glob strings.`);
        }
        return parsed as string[];
    }
    return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/**
 * The starter file holds nothing but the shape. Pre-filling every provider and
 * every default looked helpful and was not: it buried the one real decision in
 * placeholders, and writing today's defaults into the file freezes them, so a
 * later change to a default model would be silently overridden by this copy.
 */
export const CONFIG_TEMPLATE: DeepseeConfig = {
    // Empty means the built-in default provider.
    provider: '',
    providers: {},
};

/** Write a starter config. Refuses to overwrite unless force is set. */
export function initConfigFile(configPath = CONFIG_PATH, force = false): void {
    if (!force && fs.existsSync(configPath)) {
        throw new Error(`${configPath} already exists. Use --force to overwrite.`);
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(configPath, 0o600);
    } catch {
        // best effort on platforms without chmod
    }
}

/**
 * Render the effective config: the file merged with environment variables, with
 * API keys masked and every value tagged with where it came from (file or env).
 *
 * Reading only the file misled anyone who set a key through GEMINI_API_KEY (or
 * the other bound vars): the value deepsee actually uses never showed up.
 */
export function renderEffectiveConfig(
    config: DeepseeConfig,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const providerNames = new Set<string>(Object.keys(config.providers ?? {}));
    for (const [providerName, bindings] of Object.entries(ENV_BINDINGS)) {
        if (Object.values(bindings).some((envName) => env[envName]?.trim())) {
            providerNames.add(providerName);
        }
    }
    if (
        normalizeApiKeys(env[GEMINI_API_KEYS_ENV]).length > 0 ||
        normalizeApiKeys(env[GEMINI_API_KEY_ENV]).length > 0
    ) {
        providerNames.add('gemini-api');
    }

    const providers: Record<string, Record<string, string>> = {};
    for (const name of [...providerNames].sort()) {
        const fileSettings = config.providers?.[name] ?? {};
        const canonicalProviderName = providerAliases()[name] ?? name;
        const bindings = ENV_BINDINGS[canonicalProviderName] ?? {};
        const fields: Record<string, string> = {};

        if (canonicalProviderName === 'gemini-api') {
            const envKeys = normalizeApiKeys(env[GEMINI_API_KEYS_ENV]);
            const envLegacyKeys = normalizeApiKeys(env[GEMINI_API_KEY_ENV]);
            const fileKeys = normalizeApiKeys(fileSettings.apiKeys);
            const fileLegacyKeys = normalizeApiKeys(fileSettings.apiKey);
            const keys =
                envKeys.length > 0
                    ? envKeys
                    : envLegacyKeys.length > 0
                      ? envLegacyKeys
                      : fileKeys.length > 0
                        ? fileKeys
                        : fileLegacyKeys;
            if (keys.length > 0) {
                const source = envKeys.length > 0 || envLegacyKeys.length > 0 ? 'env' : 'file';
                const usingPlural =
                    envKeys.length > 0 || (envLegacyKeys.length === 0 && fileKeys.length > 0);
                if (usingPlural) {
                    // Do not render raw arrays: config show is intentionally
                    // safe to paste into an issue. The count remains useful
                    // without disclosing any key material.
                    fields.apiKeys = `${keys.length} key${keys.length === 1 ? '' : 's'} (${source})`;
                } else {
                    // Preserve the legacy field's existing masked shape for
                    // callers/tests that still inspect apiKey.
                    fields.apiKey = `${maskKey(keys[0])} (${source})`;
                }
            }
        }

        for (const field of STRING_FIELDS) {
            // Gemini's key fields are resolved above so plural and legacy
            // forms cannot both appear with conflicting effective values.
            if (canonicalProviderName === 'gemini-api' && field === 'apiKey') {
                continue;
            }
            const envName = bindings[field];
            const envValue = envName ? env[envName]?.trim() : undefined;
            const value = envValue ?? fileSettings[field];
            const source = envValue ? 'env' : fileSettings[field] !== undefined ? 'file' : null;
            if (value !== undefined && source) {
                // config show exists to be pasted into issues: keys are
                // masked, and a proxy URL's userinfo is a credential too.
                const shown =
                    field === 'apiKey'
                        ? maskKey(value)
                        : field === 'proxy'
                          ? maskUrlCredentials(value)
                          : value;
                fields[field] = `${shown} (${source})`;
            }
        }
        // No env binding and no secret to mask, but it changes what gets sent,
        // so it belongs in the effective view.
        if (fileSettings.extraBody !== undefined) {
            fields.extraBody = `${JSON.stringify(fileSettings.extraBody)} (file)`;
        }
        if (Object.keys(fields).length > 0) {
            providers[name] = fields;
        }
    }

    const effective: {
        provider?: string;
        proxy?: string;
        providers: Record<string, Record<string, string>>;
        guards?: Record<string, string>;
        reuse?: Record<string, string>;
    } = {
        providers,
    };
    if (config.provider?.trim()) {
        effective.provider = config.provider.trim();
    }
    if (config.proxy?.trim()) {
        effective.proxy = `${maskUrlCredentials(config.proxy.trim())} (file)`;
    } else if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
        const raw = (env.HTTPS_PROXY ||
            env.https_proxy ||
            env.HTTP_PROXY ||
            env.http_proxy) as string;
        effective.proxy = `${maskUrlCredentials(raw)} (env)`;
    }
    if (config.guards) {
        const guards: Record<string, string> = {};
        if (config.guards.denyModels !== undefined) {
            guards.denyModels = `${JSON.stringify(config.guards.denyModels)} (file)`;
        }
        if (config.guards.allowModels !== undefined) {
            guards.allowModels = `${JSON.stringify(config.guards.allowModels)} (file)`;
        }
        if (config.guards.denyWhenUnknown !== undefined) {
            guards.denyWhenUnknown = `${config.guards.denyWhenUnknown} (file)`;
        }
        if (Object.keys(guards).length > 0) {
            effective.guards = guards;
        }
    }
    // The onboarding flow decides whether to ask by reading this view, so a
    // recorded refusal must be visible or the user gets re-asked forever.
    if (config.reuse && Object.keys(config.reuse).length > 0) {
        effective.reuse = Object.fromEntries(
            Object.entries(config.reuse).map(([harness, granted]) => [
                harness,
                `${granted} (file)`,
            ]),
        );
    }
    return JSON.stringify(effective, null, 2);
}

function maskKey(key: string): string {
    if (key.length <= 8) {
        return '****';
    }
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
}
