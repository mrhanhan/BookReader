import { expect, test } from '@playwright/test';

interface WebManifest {
  display?: string;
  icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
}

/**
 * Installability is asserted through the public entry point: the document
 * links a manifest, the manifest declares standalone display and every icon
 * it advertises is served as a real PNG.
 */
test('serves an installable manifest and PNG icons', async ({ page, request }) => {
  await page.goto('/');
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');

  const response = await request.get('/manifest.webmanifest');
  expect(response.status(), 'manifest response').toBe(200);
  const manifest = (await response.json()) as WebManifest;
  expect(manifest.display).toBe('standalone');

  const icons = manifest.icons ?? [];
  expect(icons, 'manifest icon list').toHaveLength(3);
  for (const icon of icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), `icon ${icon.src}`).toBe(200);
    expect(
      iconResponse.headers()['content-type'],
      `content type for ${icon.src}`,
    ).toContain('image/png');
  }
});
