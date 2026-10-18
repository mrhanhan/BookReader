import { expect, it } from 'vitest';
import { buildPdfToc } from '../pdf/outline';

it('flattens nested outline items with page locators', async () => {
  const toc = await buildPdfToc([
    { title: '第一章', dest: ['p1'], items: [{ title: '第一节', dest: ['p3'] }] },
    { title: '第二章', dest: ['p8'] },
  ], 10, async (dest) => {
    const key = Array.isArray(dest) ? dest[0] : dest;
    return ({ p1: 1, p3: 3, p8: 8 } as Record<string, number>)[key as string] ?? null;
  });

  expect(toc.map((item) => [item.label, item.depth, item.locator.page])).toEqual([
    ['第一章', 0, 1], ['第一节', 1, 3], ['第二章', 0, 8],
  ]);
  expect(toc[0]!.locator.percent).toBe(0);
  expect(toc[1]!.depth).toBe(1);
  expect(toc[1]!.locator.percent).toBe(0.2);
});

it('falls back to one item per page when the outline is empty', async () => {
  const toc = await buildPdfToc([], 3, async () => null);
  expect(toc.map((item) => item.label)).toEqual(['第 1 页', '第 2 页', '第 3 页']);
});
