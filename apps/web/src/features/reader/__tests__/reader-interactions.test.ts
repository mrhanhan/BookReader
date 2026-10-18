import { expect, it } from 'vitest';
import { isInteractiveTarget } from '../interactions';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

it('treats clicks inside links and buttons as interactive', () => {
  const host = mount('<a href="/chapter-2.xhtml"><span id="link-child">next</span></a>');
  const linkChild = host.querySelector('#link-child');
  expect(isInteractiveTarget(linkChild)).toBe(true);

  const buttonHost = mount('<button type="button"><em id="button-child">播放</em></button>');
  const buttonChild = buttonHost.querySelector('#button-child');
  expect(isInteractiveTarget(buttonChild)).toBe(true);
});

it('does not treat plain reading text as interactive', () => {
  const host = mount('<p id="paragraph">正文段落</p>');
  const paragraph = host.querySelector('#paragraph');
  expect(isInteractiveTarget(paragraph)).toBe(false);
  expect(isInteractiveTarget(paragraph?.firstChild ?? null)).toBe(false);
});

it('recognizes form controls, link roles and editable regions', () => {
  const host = mount(
    '<input id="input"><select id="select"></select><label id="label">标签</label>' +
      '<span id="link-role" role="link">链接</span>' +
      '<div id="editable" contenteditable="true">可编辑</div>',
  );
  for (const id of ['input', 'select', 'label', 'link-role', 'editable']) {
    expect(isInteractiveTarget(host.querySelector(`#${id}`)), id).toBe(true);
  }
});

it('falls back to a tag walk for targets that cannot use closest', () => {
  const host = mount('<a href="/chapter-3.xhtml"><span id="link-child">next</span></a>');
  const linkChild = host.querySelector('#link-child') as HTMLElement;
  const withoutClosest = {
    tagName: linkChild.tagName,
    parentElement: linkChild.parentElement,
  };
  expect(isInteractiveTarget(withoutClosest as unknown as EventTarget)).toBe(true);
});
