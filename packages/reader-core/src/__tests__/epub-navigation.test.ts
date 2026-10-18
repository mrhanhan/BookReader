import { expect, it } from 'vitest';
import {
  bookHrefResolver,
  epubLocator,
  flattenNavigation,
  spineCfiFor,
} from '../epub/navigation';

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

it('resolves nav hrefs to spine CFI bases instead of canonical URLs', () => {
  const spineItems = [
    { href: 'text/ch1.xhtml', url: 'text/ch1.xhtml', cfiBase: '/6/2[ch1]' },
    { href: 'text/ch2.xhtml', url: 'text/ch2.xhtml', cfiBase: '/6/4[ch2]' },
    { href: '附录/notes.xhtml', url: '附录/notes.xhtml', cfiBase: '/6/6[notes]' },
  ];
  const spine = {
    spineItems,
    get(target: string) {
      return this.spineItems.find((item) => item.href === target) ?? null;
    },
  };
  const book = {
    // epub.js' canonical() returns an absolute URL, not a CFI.
    canonical: (href: string) => `https://example.test/books/1/${href}`,
    spine,
  };

  expect(spineCfiFor(book, 'text/ch1.xhtml')).toBe('epubcfi(/6/2[ch1])');
  // Navigation files in another directory resolve by path suffix.
  expect(spineCfiFor(book, '../text/ch2.xhtml#s2')).toBe('epubcfi(/6/4[ch2])');
  expect(spineCfiFor(book, 'notes.xhtml')).toBe('epubcfi(/6/6[notes])');
  // The canonical URL is also a viable suffix-matching candidate.
  expect(spineCfiFor(book, 'https://example.test/books/1/text/ch1.xhtml'))
    .toBe('epubcfi(/6/2[ch1])');
  expect(spineCfiFor(book, 'missing.xhtml')).toBeNull();
});

it('uses spine CFI bases in TOC locators and skips unresolvable entries', () => {
  const spineItems = [
    { href: 'text/ch1.xhtml', url: 'text/ch1.xhtml', cfiBase: '/6/2[ch1]' },
  ];
  const book = {
    canonical: (href: string) => href,
    spine: { get: () => null, spineItems },
  };

  const toc = flattenNavigation([
    { label: '第一章', href: 'ch1.xhtml' },
    { label: '缺失', href: 'missing.xhtml' },
  ], bookHrefResolver(book));

  expect(toc.map((item) => item.label)).toEqual(['第一章']);
  expect(toc[0]!.locator).toMatchObject({
    kind: 'epub',
    cfi: 'epubcfi(/6/2[ch1])',
    href: 'ch1.xhtml',
    percent: 0,
  });
});
