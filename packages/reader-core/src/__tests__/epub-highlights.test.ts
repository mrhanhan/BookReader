import { expect, it } from 'vitest';
import { decorateNoteMarksInViews } from '../epub/highlights';

function markUp(ids: readonly string[]): HTMLElement {
  const view = document.createElement('div');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const id of ids) {
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    mark.setAttribute('class', 'bookr-epub-hl');
    mark.setAttribute('data-id', id);
    svg.append(mark);
  }
  view.append(svg);
  return view;
}

it('adds and removes the note class on marks inside the rendition view element', () => {
  const view = markUp(['h1', 'h2']);
  const views = [{ element: view }, { element: null }, {}];

  decorateNoteMarksInViews(views, [
    { id: 'h1', hasNote: true },
    { id: 'h2', hasNote: false },
  ]);
  const marks = view.querySelectorAll('.bookr-epub-hl');
  expect(marks[0]!.classList.contains('bookr-epub-hl-note')).toBe(true);
  expect(marks[1]!.classList.contains('bookr-epub-hl-note')).toBe(false);

  decorateNoteMarksInViews(views, [
    { id: 'h1', hasNote: false },
    { id: 'h2', hasNote: true },
  ]);
  expect(marks[0]!.classList.contains('bookr-epub-hl-note')).toBe(false);
  expect(marks[1]!.classList.contains('bookr-epub-hl-note')).toBe(true);
});

it('ignores views without an element and empty highlight lists', () => {
  const view = markUp(['h1']);
  decorateNoteMarksInViews([{ element: null }, {}], [{ id: 'h1', hasNote: true }]);
  expect(view.querySelector('.bookr-epub-hl')!.classList.contains('bookr-epub-hl-note'))
    .toBe(false);
});
