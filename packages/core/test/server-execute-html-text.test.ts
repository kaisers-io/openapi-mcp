import { describe, expect, it } from 'vitest';
import { htmlErrorText } from '../src/server/execute/html-text.ts';

// Issue #63: the readable part of an HTML error page
describe('htmlErrorText', () => {
  it.each([
    ['nothing hidden in an unclosed <style>', '<p>A</p><style>p{}', 'A'],
    ['a comment', '<p>A<!-- B -->C</p>', 'A C'],
    [
      'hidden elements in the body',
      '<p>A</p><script>s</script><noscript>n</noscript><svg>v</svg><template>t</template>B',
      'A B',
    ],
    ['a head without its end tag', '<head><title>T</title><meta charset=utf-8><body>B', 'T: B'],
    ['an unclosed comment', '<p>A</p><!-- B', 'A'],
    ['a self-closing hidden element', '<p>A</p><svg/><p>B</p>', 'A B'],
    ['a `<` that opens no tag', '<p>1 < 2</p>', '1 < 2'],
    ['a `<` after the last `>`', '<p>A</p> x <y', 'A x <y'],
    ['upper-case tags', '<HTML><HEAD><TITLE>T</TITLE></HEAD><BODY>B</BODY></HTML>', 'T: B'],
    ['numeric and named entities', '<p>&#65;&#x42;&copy;&unknown;&#0;</p>', 'AB©&unknown;&#0;'],
    ['a title only', '<title>Only</title>', 'Only'],
    ['an unclosed <title> tag', '<title', '<title'],
    ['an unclosed title', '<title>Never closed', ''],
    ['plain text', 'just text', 'just text'],
  ])('handles %s', (_name, html, expected) => {
    expect(htmlErrorText(html)).toBe(expected);
  });

  it('stays linear on markup that never closes a tag', () => {
    const hostile = `${'<a'.repeat(200_000)}>${'<style>'.repeat(50_000)}`;
    const started = performance.now();
    htmlErrorText(hostile);
    htmlErrorText('<a'.repeat(400_000));
    htmlErrorText('<title'.repeat(200_000));
    htmlErrorText(`${'</title '.repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
