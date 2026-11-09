// Stands in for ffmpeg in the worker tests (run by node). Answers -version, writes a small file for a lavfi test tone
// (tabula worker doctor), and "extracts audio" by copying the input (-i) to the output (the last argument).
// FAKE_FFMPEG_NO_AUDIO=1 behaves like a video without a sound track.
import { copyFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version 0.0-fake Copyright (c) the tests\n');
  process.exit(0);
}
const out = args.at(-1);
if (args.includes('lavfi')) {
  writeFileSync(out, Buffer.alloc(44));
  process.exit(0);
}
if (process.env.FAKE_FFMPEG_NO_AUDIO === '1') {
  process.stderr.write('Output file #0 does not contain any stream\n');
  process.exit(1);
}
copyFileSync(args[args.indexOf('-i') + 1], out);
