// Stands in for cli/transcribe.py in the worker tests (run by node). FAKE_TRANSCRIBE: ok (default) | fail | env | slow.
// --check answers like the real script; FAKE_TRANSCRIBE_CUDA=0 reports no CUDA device. FAKE_TRANSCRIBE_LOG gets the
// options of every run as one JSON line.
import { appendFileSync, existsSync } from 'node:fs';

if (process.argv.includes('--check')) {
  const cuda = process.env.FAKE_TRANSCRIBE_CUDA === '0' ? 0 : 1;
  process.stdout.write(JSON.stringify({
    python: '3.14.0', faster_whisper: '1.2.1', ctranslate2: '4.8.4', cuda_devices: cuda, compute_types: cuda ? ['float16', 'int8'] : [],
  }));
  process.exit(0);
}
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const options = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (process.env.FAKE_TRANSCRIBE_LOG) {
  appendFileSync(process.env.FAKE_TRANSCRIBE_LOG, `${JSON.stringify({ ...options, wavExists: existsSync(options.wav) })}\n`);
}
const mode = process.env.FAKE_TRANSCRIBE ?? 'ok';
if (mode === 'fail') {
  process.stderr.write('Traceback: boom\n');
  process.exit(1);
}
if (mode === 'env') {
  process.stderr.write('transcribe.py: CUDA is not available (no NVIDIA GPU or driver found)\n');
  process.exit(3);
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 8000));
process.stdout.write(JSON.stringify({
  language: 'sk',
  duration_ms: 4200,
  segments: [
    { start_ms: 0, end_ms: 1500.4, text: '  Ahoj, toto je test. ' },
    { start_ms: 161000, end_ms: 163000, text: 'Tu sa tlačidlo zasekne.' },
    { start_ms: 170000, end_ms: 170500, text: '   ' },
  ],
}));
