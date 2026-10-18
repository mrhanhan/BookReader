import { Link } from 'react-router';

/**
 * `/books/:id` placeholder. The duplicate-upload link points here until the
 * reader ships, so the shelf never offers a dead end.
 */
export function BookPlaceholderPage() {
  return (
    <section className="flex flex-col items-center gap-3 py-20 text-center">
      <h1 className="font-serif text-2xl text-ink">阅读器即将上线</h1>
      <p className="max-w-sm text-sm leading-6 text-muted">
        这本书已经在书架里了。阅读、书签和进度同步都会在这里出现，稍后再来看看。
      </p>
      <Link
        to="/"
        className="mt-2 text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        返回书架
      </Link>
    </section>
  );
}
