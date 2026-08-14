import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// The helper is dependency-free JavaScript by design.
// @ts-expect-error no declaration file is published for the internal module
const visualCheck = await import('../dsh/visual-check.js');
const {
    capturePreviewScreenshot,
    findBrowserExecutable,
    isAllowedPreviewUrl,
    MAX_SCREENSHOT_BYTES,
    parseViewport,
} = visualCheck;

const tempDirectories: string[] = [];

afterEach(() => {
    while (tempDirectories.length > 0) {
        const directory = tempDirectories.pop();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
});

function tempDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepsee-visual-check-test-'));
    tempDirectories.push(directory);
    return directory;
}

function writePng(filePath: string): void {
    fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
}

describe('visual check URL policy', () => {
    it('allows only local HTTP(S) preview URLs', () => {
        expect(isAllowedPreviewUrl('http://localhost:3000/')).toBe(true);
        expect(isAllowedPreviewUrl('https://LOCALHOST:8443/app')).toBe(true);
        expect(isAllowedPreviewUrl('http://127.0.0.1:5173')).toBe(true);
        expect(isAllowedPreviewUrl('http://127.255.255.255:5173')).toBe(true);
        expect(isAllowedPreviewUrl('https://[::1]:8443')).toBe(true);
    });

    it('rejects credentials, non-loopback hosts, and non-http protocols', () => {
        expect(isAllowedPreviewUrl('http://user:pass@localhost:3000')).toBe(false);
        expect(isAllowedPreviewUrl('http://localhost.example.com')).toBe(false);
        expect(isAllowedPreviewUrl('http://10.0.0.1:3000')).toBe(false);
        expect(isAllowedPreviewUrl('http://[::2]:3000')).toBe(false);
        expect(isAllowedPreviewUrl('file:///tmp/page.html')).toBe(false);
        expect(isAllowedPreviewUrl('ftp://localhost:3000')).toBe(false);
        expect(isAllowedPreviewUrl('not a URL')).toBe(false);
    });
});

describe('visual check viewport and browser discovery', () => {
    it('parses bounded viewport values and defaults', () => {
        expect(parseViewport()).toEqual({ width: 1440, height: 900 });
        expect(parseViewport('1280x720')).toEqual({ width: 1280, height: 720 });
        expect(parseViewport({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
        expect(() => parseViewport('319x720')).toThrow(/width/);
        expect(() => parseViewport('1280x2161')).toThrow(/height/);
        expect(() => parseViewport({ width: 640.5, height: 480 })).toThrow(/width/);
        expect(() => parseViewport('640-480')).toThrow(/WIDTHxHEIGHT/);
    });

    it('prefers an existing explicit browser override', () => {
        const seen: string[] = [];
        const browser = findBrowserExecutable({
            platform: 'linux',
            env: { DEEPSEE_BROWSER_PATH: '/custom/chrome' },
            exists: (candidate: string) => {
                seen.push(candidate);
                return candidate === '/custom/chrome';
            },
        });
        expect(browser).toBe('/custom/chrome');
        expect(seen).toEqual(['/custom/chrome']);
    });

    it('falls back to platform candidates and returns null when absent', () => {
        expect(
            findBrowserExecutable({
                platform: 'darwin',
                env: {},
                exists: (candidate: string) => candidate.includes('Chromium.app'),
            }),
        ).toContain('Chromium.app');
        expect(
            findBrowserExecutable({ platform: 'linux', env: {}, exists: () => false }),
        ).toBeNull();
    });
});

describe('capturePreviewScreenshot', () => {
    it('finishes when Chrome has written a valid screenshot even if the process stays alive', async () => {
        const directory = tempDirectory();
        const outputPath = path.join(directory, 'preview.png');
        let stoppedAfterCapture = false;

        const result = await capturePreviewScreenshot({
            url: 'http://localhost:4173/app',
            outputPath,
            browserPath: '/custom/chrome',
            timeoutMs: 250,
            runBrowser: (options: { signal: AbortSignal }) => {
                writePng(outputPath);
                return new Promise((resolve) => {
                    options.signal.addEventListener(
                        'abort',
                        () => {
                            stoppedAfterCapture = true;
                            resolve(undefined);
                        },
                        { once: true },
                    );
                });
            },
        });

        expect(result.path).toBe(outputPath);
        expect(stoppedAfterCapture).toBe(true);
    });

    it('uses safe argv, validates output magic, and removes the temporary profile', async () => {
        const directory = tempDirectory();
        const outputPath = path.join(directory, 'preview.png');
        let invocation:
            | {
                  browserPath: string;
                  args: string[];
                  profilePath: string;
              }
            | undefined;

        const result = await capturePreviewScreenshot({
            url: 'http://localhost:4173/app',
            outputPath,
            viewport: '1280x720',
            browserPath: '/custom/chrome',
            runBrowser: async (options: {
                browserPath: string;
                args: string[];
                profilePath: string;
            }) => {
                invocation = options;
                writePng(outputPath);
            },
        });

        expect(result).toEqual({
            url: 'http://localhost:4173/app',
            path: outputPath,
            viewport: { width: 1280, height: 720 },
            browser: '/custom/chrome',
        });
        expect(invocation?.browserPath).toBe('/custom/chrome');
        expect(invocation?.args).toContain('--headless=new');
        expect(invocation?.args).toContain('--window-size=1280,720');
        expect(invocation?.args).toContain(`--screenshot=${outputPath}`);
        expect(invocation?.args).toContain('http://localhost:4173/app');
        expect(invocation?.args.some((argument) => argument.includes('--user-data-dir='))).toBe(
            true,
        );
        expect(
            invocation?.args.some((argument) =>
                /user:pass|--no-sandbox|--disable-web-security|--remote-debugging-/.test(argument),
            ),
        ).toBe(false);
        expect(invocation?.profilePath).toBeTruthy();
        expect(fs.existsSync(invocation?.profilePath ?? '')).toBe(false);
    });

    it('rejects invalid or oversized output and still cleans the profile', async () => {
        const directory = tempDirectory();
        const outputPath = path.join(directory, 'preview.bin');
        let profilePath = '';
        await expect(
            capturePreviewScreenshot({
                url: 'http://127.0.0.1:4173',
                outputPath,
                browserPath: '/custom/chrome',
                runBrowser: async (options: { profilePath: string }) => {
                    profilePath = options.profilePath;
                    fs.writeFileSync(outputPath, Buffer.from('not an image'));
                },
            }),
        ).rejects.toThrow(/PNG, JPEG, or WebP/);
        expect(fs.existsSync(profilePath)).toBe(false);

        profilePath = '';
        await expect(
            capturePreviewScreenshot({
                url: 'http://localhost:4173',
                outputPath,
                browserPath: '/custom/chrome',
                runBrowser: async (options: { profilePath: string }) => {
                    profilePath = options.profilePath;
                    fs.writeFileSync(outputPath, Buffer.alloc(1));
                    fs.truncateSync(outputPath, MAX_SCREENSHOT_BYTES + 1);
                },
            }),
        ).rejects.toThrow(/25 MiB/);
        expect(fs.existsSync(profilePath)).toBe(false);
    });

    it('cleans the temporary profile when the browser runner fails', async () => {
        const directory = tempDirectory();
        const outputPath = path.join(directory, 'preview.png');
        let profilePath = '';
        await expect(
            capturePreviewScreenshot({
                url: 'https://[::1]:4173',
                outputPath,
                browserPath: '/custom/chrome',
                runBrowser: async (options: { profilePath: string }) => {
                    profilePath = options.profilePath;
                    throw new Error('runner failed');
                },
            }),
        ).rejects.toThrow('runner failed');
        expect(fs.existsSync(profilePath)).toBe(false);
    });
});
