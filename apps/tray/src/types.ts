// What the Rust core sends (state.rs, Snapshot; serde renames the fields to camelCase).
export type Icon = 'stopped' | 'waiting' | 'idle' | 'busy' | 'error';

export type LogLine = { atMs: number; text: string; error: boolean };

export type JobView = { project: string; title: string; reportUrl: string; recording: string; step: string; percent: number | null };

export type QueueView = { text: string; error: boolean; checkedAtMs: number | null };

export type Snapshot = {
  icon: Icon;
  tooltip: string;
  status: string;
  headline: string;
  note: string | null;
  canStart: boolean;
  canStop: boolean;
  stopLabel: string;
  canDoctor: boolean;
  job: JobView | null;
  queue: QueueView;
  log: LogLine[];
};
