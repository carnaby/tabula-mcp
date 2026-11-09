import { describe, expect, it } from 'vitest';
import { estimateTokens, wordCount } from '../../src/domain/tokens.js';

describe('tokens', () => {
  it('estimates chars / 4 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('counts words', () => {
    expect(wordCount('  one two\nthree ')).toBe(3);
    expect(wordCount('   ')).toBe(0);
  });
});
