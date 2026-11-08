// The tray window: it shows the snapshots the Rust core sends (event "state") and turns clicks into its commands.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './style.css';
import type { LogLine, Snapshot } from './types';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing in index.html`);
  return found as T;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function renderLog(lines: LogLine[]): void {
  const list = el('log');
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  list.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement('li');
      item.classList.toggle('error', line.error);
      const time = document.createElement('time');
      time.textContent = clock(line.atMs);
      item.append(time, line.text);
      return item;
    }),
  );
  if (atEnd) list.scrollTop = list.scrollHeight;
}

function render(s: Snapshot): void {
  el('dot').dataset.icon = s.icon;
  el('headline').textContent = s.headline;
  const note = el('note');
  note.hidden = !s.note;
  note.textContent = s.note ?? '';
  el<HTMLButtonElement>('process').disabled = !s.canStart;
  el<HTMLButtonElement>('start').disabled = !s.canStart;
  const stop = el<HTMLButtonElement>('stop');
  stop.disabled = !s.canStop;
  stop.textContent = s.stopLabel;
  el<HTMLButtonElement>('doctor').disabled = !s.canDoctor;

  el('job').hidden = !s.job;
  if (s.job) {
    el('job-title').textContent = `${s.job.project}: ${s.job.title}`;
    el('job-meta').textContent = `${s.job.recording} · ${s.job.step}${s.job.percent === null ? '' : ` ${s.job.percent} %`}`;
    el('job-bar').style.width = `${s.job.percent ?? 0}%`;
  }

  const queue = el('queue');
  queue.textContent = s.queue.text;
  queue.classList.toggle('error', s.queue.error);
  el('checked').textContent = s.queue.checkedAtMs === null ? '' : `Checked at ${clock(s.queue.checkedAtMs)}`;
  renderLog(s.log);
}

const command = (name: string, args?: Record<string, unknown>) => () => {
  invoke(name, args).catch((e: unknown) => console.error(`${name} failed`, e));
};

el('process').addEventListener('click', command('start', { once: true }));
el('start').addEventListener('click', command('start', { once: false }));
el('stop').addEventListener('click', command('stop'));
el('doctor').addEventListener('click', command('run_doctor'));
el('folder').addEventListener('click', command('open_log_folder'));
el('job-title').addEventListener('click', (e) => {
  e.preventDefault();
  command('open_report')();
});

// The first paint asks for the snapshot; a state event that comes first is newer, and the answer must not undo it.
let painted = false;
void listen<Snapshot>('state', (event) => {
  painted = true;
  render(event.payload);
});
invoke<Snapshot>('snapshot')
  .then((s) => {
    if (!painted) render(s);
  })
  .catch(console.error);
