// Stands in for cli/tabula.mjs in the tray's tests (run by node). The mode is in a file named "mode" next to this
// script: ok (default) | stubborn (ignores stop and the end of its input) | garbage (writes lines that are no events)
// | crash (exits 1 without "stopped") | old (a CLI before 1.3.0) | slowqueue (worker queue never answers).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const modeFile = join(dirname(fileURLToPath(import.meta.url)), 'mode');
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'ok';
const args = process.argv.slice(2);
const emit = (type, fields = {}) => process.stdout.write(`${JSON.stringify({ type, time: new Date().toISOString(), ...fields })}\n`);

if (mode === 'old') {
  // What tabula 1.2.0 prints for "worker queue --json" and "worker --events".
  process.stderr.write(args.includes('--json') ? 'tabula: tabula worker does not take --json\n' : 'tabula: tabula worker does not take --events\n');
  process.exitCode = 1;
} else if (args[0] === 'worker' && args[1] === 'queue') {
  if (mode === 'slowqueue') setTimeout(() => {}, 60000);
  else process.stdout.write(`${JSON.stringify({ ok: true, server: 'http://127.0.0.1:9', queued: 2, running: 0, worker_last_seen: null })}\n`);
} else if (args[0] === 'worker' && args[1] === 'doctor') {
  process.stdout.write('ok    fake doctor\nEverything works.\n');
} else if (args[0] === 'worker' && args.includes('--events')) {
  emit('started', { version: '1.3.0', once: args.includes('--once'), server: 'http://127.0.0.1:9' });
  if (mode === 'crash') {
    emit('log', { text: 'something broke' });
    process.stderr.write('Error: boom\n');
    process.exitCode = 1;
  } else {
    if (mode === 'garbage') process.stdout.write('not json\n{"type":"idle","time":"2026-11-08T10:00:00.000Z"}\r\n{"type":"surprise"}\n');
    else emit('idle');
    if (args.includes('--once')) {
      emit('stopped', { done: 0, failed: 0, code: 0 });
    } else {
      const keepAlive = setInterval(() => {}, 1000);
      let finished = false;
      const finish = () => {
        if (finished) return; // "stop" and then the end of the input: one stopped event
        finished = true;
        emit('stopped', { done: 0, failed: 0, code: 0 });
        clearInterval(keepAlive);
        process.stdin.destroy();
      };
      if (mode !== 'stubborn') {
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => {
          if (d.includes('stop')) finish();
        });
        process.stdin.on('end', finish);
      }
    }
  }
}
