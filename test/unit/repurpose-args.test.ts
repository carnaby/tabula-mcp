import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/maintenance/repurpose.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('repurpose parseArgs', () => {
  it('accepts the valid forms', () => {
    expect(parseArgs([])).toEqual({ apply: false, archiveGlobal: [] });
    expect(parseArgs(['--apply'])).toEqual({ apply: true, archiveGlobal: [] });
    expect(parseArgs(['--apply', `--archive-global=${A.toUpperCase()},${B}`])).toEqual({ apply: true, archiveGlobal: [A, B] });
  });
  it.each([
    [['--aply']],
    [['--archive-global', A]],
    [['--archive-global']],
    [['--archive-global=']],
    [[`--archive-global=${A},`]],
    [['--archive-global=abc']],
    [[`--archive-global=${A.slice(0, 8)}`]],
    [[A]],
    [['--apply', '--apply']],
    [[`--archive-global=${A}`, `--archive-global=${B}`]],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/Usage/);
  });
});
