import { expect, it } from 'vitest';
import { epubLocator, flattenNavigation } from '../epub/navigation';

it('flattens nested EPUB navigation into depth-tagged toc items', () => {
  const canonical = (href: string) => `cfi:${href}`;
  const toc = flattenNavigation([
    { label: '第一章', href: 'ch1.xhtml' },
    { label: '第二章', href: 'ch2.xhtml', subitems: [
      { label: '第二节', href: 'ch2.xhtml#s2' },
    ] },
  ], canonical);
  expect(toc.map((item) => [item.label, item.depth, item.locator.kind])).toEqual([
    ['第一章', 0, 'epub'], ['第二章', 0, 'epub'], ['第二节', 1, 'epub'],
  ]);
  expect(toc[2]!.locator).toMatchObject({ cfi: 'cfi:ch2.xhtml#s2', href: 'ch2.xhtml#s2' });
});

it('builds an EPUB locator with a clamped percentage', () => {
  expect(epubLocator('epubcfi(/6/4!/2)', 'ch1.xhtml', 0.42))
    .toEqual({ kind: 'epub', cfi: 'epubcfi(/6/4!/2)', href: 'ch1.xhtml', percent: 0.42 });
  expect(epubLocator('epubcfi(/6/4!/2)', undefined, 3).percent).toBe(1);
  expect('href' in epubLocator('epubcfi(/6/4!/2)', undefined, 0)).toBe(false);
});

it('skips navigation entries whose canonical lookup throws', () => {
  const toc = flattenNavigation([
    { label: '坏章节', href: 'missing.xhtml' },
    { label: '好章节', href: 'ch1.xhtml' },
  ], (href) => {
    if (href === 'missing.xhtml') {
      throw new Error('not in spine');
    }
    return `cfi:${href}`;
  });
  expect(toc.map((item) => item.label)).toEqual(['好章节']);
  expect(toc[0]!.id).toBe('toc-1');
});
