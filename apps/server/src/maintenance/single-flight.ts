/**
 * A periodic task that never runs twice at once: a tick while the previous run is still going gets that run instead
 * of starting another, so a slow database cannot pile up sweeps.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}
