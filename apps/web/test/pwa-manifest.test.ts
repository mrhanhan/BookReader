import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.webmanifest'), 'utf8'));

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  it('describes an installable standalone app', () => {
    expect(manifest).toMatchObject({
      name: '纸墨书房',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#F6F1E7',
      background_color: '#F6F1E7',
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    ]));
  });

  it('ships real PNGs at the declared sizes', () => {
    expect(pngSize(resolve(root, 'public/icons/icon-192.png'))).toEqual({ width: 192, height: 192 });
    expect(pngSize(resolve(root, 'public/icons/icon-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(resolve(root, 'public/icons/icon-maskable-512.png'))).toEqual({ width: 512, height: 512 });
    expect(pngSize(resolve(root, 'public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('links the manifest from the shell', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });
});
