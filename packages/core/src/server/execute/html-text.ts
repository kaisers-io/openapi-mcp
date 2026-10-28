// The readable part of an HTML error page (issue #63). Real error pages often
// start with kilobytes of <head>, <style> or <script>, so the first kilobyte
// of the markup can hold no message at all. Measured on 20 real or
// framework-default error pages (nginx, Apache, Tomcat, Express, Spring,
// Django, Rails, Laravel, Heroku, Firebase, GitHub Pages and others): the
// first kilobyte of the markup held the message for 16, the title followed
// by the visible text for all 20.
//
// One forward pass: every search starts where the previous one ended, so the
// work stays linear in the body size, which the response budget bounds.

// Elements whose content is never visible text. <title> is read separately.
const HIDDEN = new Set(['head', 'style', 'script', 'noscript', 'svg', 'template', 'title']);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
};

const decodeEntities = (text: string): string =>
  text.replaceAll(/&(?<body>#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu, (entity, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? Number(`0x${body.slice(2)}`) : Number(body.slice(1));
      return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : entity;
    }
    return NAMED[body.toLowerCase()] ?? entity;
  });

const collapse = (text: string): string => decodeEntities(text).replaceAll(/\s+/gu, ' ').trim();

const titleOf = (html: string): string => {
  // No `[^>]*` here: on a page with many `<title` and no `>` it would scan to
  // the end once per match
  const open = /<title\b/iu.exec(html);
  if (open === null) {
    return '';
  }
  const start = html.indexOf('>', open.index) + 1;
  if (start === 0) {
    return '';
  }
  const close = /<\/title\s*>/giu;
  close.lastIndex = start;
  const end = close.exec(html)?.index;
  return end === undefined ? '' : collapse(html.slice(start, end));
};

const visibleText = (html: string): string => {
  const parts: string[] = [];
  const tag = /<(?<slash>\/?)(?<name>[a-z][a-z0-9-]*)[^>]*>/giuy;
  // Past the last `>`, no tag can close: the rest is text. This also keeps
  // the tag pattern from scanning to the end once per `<`.
  const lastClose = html.lastIndexOf('>');
  let at = 0;
  while (at < html.length) {
    const next = html.indexOf('<', at);
    if (next !== -1 && html.startsWith('<!--', next)) {
      parts.push(html.slice(at, next), ' ');
      const end = html.indexOf('-->', next + 4);
      if (end === -1) {
        break;
      }
      at = end + 3;
      continue;
    }
    if (next === -1 || next > lastClose) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, next), ' ');
    // A declaration or processing instruction (`<!DOCTYPE html>`, `<?xml ?>`)
    if (html[next + 1] === '!' || html[next + 1] === '?') {
      at = html.indexOf('>', next) + 1;
      continue;
    }
    tag.lastIndex = next;
    const match = tag.exec(html);
    if (match === null) {
      // A `<` that opens no tag is text, as a browser shows it
      parts.push('<');
      at = next + 1;
      continue;
    }
    at = tag.lastIndex;
    const name = (match.groups?.['name'] ?? '').toLowerCase();
    if (match.groups?.['slash'] === '' && HIDDEN.has(name) && !match[0].endsWith('/>')) {
      const close = new RegExp(`</${name}\\s*>`, 'giu');
      close.lastIndex = at;
      const end = close.exec(html);
      if (end === null) {
        break;
      }
      at = close.lastIndex;
    }
  }
  return collapse(parts.join(''));
};

// The title, then the visible text, without repeating a title the text
// starts with. Empty when the page has neither.
export const htmlErrorText = (html: string): string => {
  const title = titleOf(html);
  const text = visibleText(html);
  if (title === '' || text.startsWith(title)) {
    return text;
  }
  return text === '' ? title : `${title}: ${text}`;
};
