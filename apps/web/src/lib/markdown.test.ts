import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders GFM', () => {
    expect(renderMarkdown('**bold** and a [link](https://example.com)')).toContain(
      '<strong>bold</strong>',
    );
  });

  it('strips script, event handlers and javascript: URLs', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    const link = renderMarkdown('[click me](javascript:alert(1))');
    expect(link).not.toMatch(/href="javascript:/i);
  });

  it('opens external links safely', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain(
      'rel="noopener noreferrer nofollow"',
    );
  });
});
