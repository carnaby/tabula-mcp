// Generates the tray's icons from icons/tray.svg with the Tauri CLI (`tauri icon`, which rasterizes SVG with resvg):
// one 32 px PNG per state for a light and for a dark taskbar (src-tauri/icons/tray/), and the app icons of the
// installers (src-tauri/icons/). Run it after changing the SVG: pnpm --dir tray icons. The PNGs are committed, so a
// build never needs this script.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauri = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const template = readFileSync(join(root, 'icons', 'tray.svg'), 'utf8');

// State colours from web/src/ui/tokens.css: the light theme's on a light taskbar, the dark theme's on a dark one.
const COLORS = {
  light: { stopped: '#57534e', idle: '#15803d', busy: '#1d4ed8', error: '#b91c1c', dot: '#d97706' },
  dark: { stopped: '#c4bfbb', idle: '#4ade80', busy: '#93c5fd', error: '#f87171', dot: '#f59e0b' },
};
/** [file name, colour, with the badge] */
const STATES = [
  ['stopped', 'stopped', false],
  ['waiting', 'stopped', true],
  ['idle', 'idle', false],
  ['busy', 'busy', false],
  ['error', 'error', false],
];
/** The app icon: the tablet in the accent colour (--accent of the light theme). */
const APP_COLOR = '#b45309';

const svg = (glyph, dot) =>
  template.replaceAll('{{glyph}}', glyph).replaceAll('{{dot}}', dot ?? 'none').replaceAll('{{dotOpacity}}', dot ? '1' : '0');

function rasterize(source, out, png) {
  const r = spawnSync(process.execPath, [tauri, 'icon', source, '--output', out, ...(png ? ['--png', png] : [])], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tauri icon failed for ${source}`);
}

const work = mkdtempSync(join(tmpdir(), 'tabula-tray-icons-'));
try {
  const trayDir = join(root, 'src-tauri', 'icons', 'tray');
  mkdirSync(trayDir, { recursive: true });
  for (const [theme, colors] of Object.entries(COLORS)) {
    for (const [name, glyph, badge] of STATES) {
      const dir = join(work, `${name}-${theme}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'icon.svg'), svg(colors[glyph], badge ? colors.dot : null));
      rasterize(join(dir, 'icon.svg'), dir, '32');
      copyFileSync(join(dir, '32x32.png'), join(trayDir, `${name}-${theme}.png`));
    }
  }
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'icon.svg'), svg(APP_COLOR, null));
  rasterize(join(app, 'icon.svg'), app);
  for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico']) {
    copyFileSync(join(app, name), join(root, 'src-tauri', 'icons', name));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
