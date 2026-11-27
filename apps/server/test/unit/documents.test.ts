import { describe, expect, it } from 'vitest';
import { cutText, documentHead, documentReader } from '../../src/domain/documents.js';

const OOXML = ['wordprocessingml.document', 'spreadsheetml.sheet', 'presentationml.presentation'].map(
  (t) => `application/vnd.openxmlformats-officedocument.${t}`,
);

describe('document text rules', () => {
  it('tells by the stored mime which documents are read from the file, which by Fornax and which not at all', () => {
    expect(documentReader({ kind: 'document', mime: 'text/plain; charset=utf-8' })).toBe('file');
    expect(documentReader({ kind: 'document', mime: 'text/markdown; charset=utf-8' })).toBe('file');
    for (const mime of ['application/pdf', ...OOXML]) expect(documentReader({ kind: 'document', mime })).toBe('fornax');
    expect(documentReader({ kind: 'document', mime: 'application/vnd.oasis.opendocument.text' })).toBeNull();
    expect(documentReader({ kind: 'image', mime: 'image/png' })).toBeNull();
  });

  it('cuts a text over the limit at the last line break before it, else hard at the limit, never inside a surrogate pair', () => {
    expect(cutText('short', 10)).toEqual({ text: 'short', truncated: false });
    expect(cutText('ab\ncd\nef', 7)).toEqual({ text: 'ab\ncd', truncated: true });
    expect(cutText('abcdefgh', 5)).toEqual({ text: 'abcde', truncated: true });
    expect(cutText('abcd😀x', 5)).toEqual({ text: 'abcd', truncated: true });
    expect(cutText('x'.repeat(1_000_001)).text).toHaveLength(1_000_000);
  });

  it('takes the first 100 lines and at most 8 000 characters as the beginning, with the offset where the rest starts', () => {
    // 1 500 lines: the prefix handed over is cut at 8 001 characters, so the 100-line rule and the 8 000 cap both apply
    const lines = Array.from({ length: 1_500 }, (_, i) => `line ${i}`).join('\n');
    expect(lines.length).toBeGreaterThan(8_001);
    const head = documentHead(lines.slice(0, 8_001), lines.length);
    expect(head.text.split('\n')).toHaveLength(100);
    expect(lines.slice(head.next!)).toMatch(/^line 100\n/);
    expect(documentHead('a\nb', 3)).toEqual({ text: 'a\nb', next: null });
    const wide = Array.from({ length: 50 }, () => 'w'.repeat(300)).join('\n');
    const cut = documentHead(wide.slice(0, 8_001), wide.length);
    expect(cut.text.length).toBeLessThanOrEqual(8_000);
    expect(cut.text.endsWith('w')).toBe(true);
    expect(cut.next).toBe(cut.text.length + 1);
    const one = 'y'.repeat(20_000);
    expect(documentHead(one.slice(0, 8_001), one.length)).toEqual({ text: 'y'.repeat(8_000), next: 8_000 });
    const emoji = `${'e'.repeat(7_999)}😀tail`;
    expect(documentHead(emoji.slice(0, 8_001), emoji.length)).toEqual({ text: 'e'.repeat(7_999), next: 7_999 });
  });
});
