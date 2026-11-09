// Stands in for apps/cli/diarize.py in the worker tests (run by node). FAKE_DIARIZE: ok (default) | fail | env | garbage | slow.
// --check answers like the real script: FAKE_DIARIZE_CUDA=0 no CUDA, FAKE_DIARIZE_TOKEN=0 no saved token,
// FAKE_DIARIZE_CACHED=0 the model not downloaded. --load offline (HF_HUB_OFFLINE=1) fails (exit 4) with
// FAKE_DIARIZE_COMPLETE=0 (a cache that holds only part of the model), online with FAKE_DIARIZE_TOKEN=0.
// FAKE_DIARIZE_LOG gets the options of every run as one JSON line.
import { appendFileSync, existsSync } from 'node:fs';

const off = (name) => process.env[name] === '0';
if (process.argv.includes('--check')) {
  process.stdout.write(JSON.stringify({
    python: '3.14.0', pyannote: '4.0.7', torch: '2.11.0+cu128', cuda: !off('FAKE_DIARIZE_CUDA'), gpu: off('FAKE_DIARIZE_CUDA') ? null : 'Fake GPU',
    token: !off('FAKE_DIARIZE_TOKEN'), model_cached: !off('FAKE_DIARIZE_CACHED'),
  }));
  process.exit(0);
}
if (process.argv.includes('--load')) {
  const offline = process.env.HF_HUB_OFFLINE === '1';
  if (process.env.FAKE_DIARIZE_LOG) appendFileSync(process.env.FAKE_DIARIZE_LOG, `${JSON.stringify({ load: true, offline })}\n`);
  if (offline && off('FAKE_DIARIZE_COMPLETE')) {
    process.stderr.write('diarize.py: the model pyannote/speaker-diarization-community-1 is not downloaded: run tabula worker setup --diarize\n');
    process.exit(4);
  }
  if (!offline && off('FAKE_DIARIZE_TOKEN')) {
    process.stderr.write('diarize.py: Hugging Face refused pyannote/speaker-diarization-community-1 (GatedRepoError)\n');
    process.exit(4);
  }
  process.stdout.write(JSON.stringify({ model: 'pyannote/speaker-diarization-community-1', loaded: true }));
  process.exit(0);
}
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const options = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (process.env.FAKE_DIARIZE_LOG) {
  appendFileSync(process.env.FAKE_DIARIZE_LOG, `${JSON.stringify({ ...options, wavExists: existsSync(options.wav) })}\n`);
}
const mode = process.env.FAKE_DIARIZE ?? 'ok';
if (mode === 'fail') {
  process.stderr.write('Traceback (most recent call last):\nRuntimeError: diarization broke\n');
  process.exit(1);
}
if (mode === 'env') {
  process.stderr.write('diarize.py: CUDA is not available to PyTorch\n');
  process.exit(3);
}
if (mode === 'garbage') {
  process.stdout.write('not json');
  process.exit(0);
}
if (mode === 'slow') {
  process.stderr.write('PROGRESS 100\n');
  await new Promise((r) => setTimeout(r, 8000));
}
// Two reports within one second: the worker turns only the first into a progress event.
process.stderr.write('PROGRESS 500\n');
process.stderr.write('PROGRESS 900\n');
// The first segment's speaker changes after "toto"; the second segment is S1's.
process.stdout.write(JSON.stringify({
  model: 'pyannote/speaker-diarization-community-1',
  speakers: 2,
  turns: [{ start_ms: 0, end_ms: 650, speaker: 'S1' }, { start_ms: 650, end_ms: 1500, speaker: 'S2' }, { start_ms: 161000, end_ms: 163000, speaker: 'S1' }],
}));
