import { describe, expect, it } from 'vitest';
import { singleFlight } from '../../src/maintenance/single-flight.js';

describe('singleFlight', () => {
  it('skips a tick while the previous run is going, and runs again after it', async () => {
    let calls = 0;
    let finish = () => {};
    const tick = singleFlight(() => {
      calls++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const first = tick();
    const skipped = tick();
    expect(calls).toBe(1);
    expect(skipped).toBe(first);
    finish();
    await first;
    const next = tick();
    expect(calls).toBe(2);
    finish();
    await next;
  });

  it('runs again after a failed run', async () => {
    let calls = 0;
    const tick = singleFlight(async () => {
      calls++;
      throw new Error('boom');
    });
    await expect(tick()).rejects.toThrow('boom');
    await expect(tick()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});
