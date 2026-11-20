import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** CHROME_PATH, or Chrome / Chromium where their installers put it. */
export function chromePath(): string {
  const env = process.env;
  const candidates = [
    env.CHROME_PATH,
    ...(process.platform === 'win32'
      ? [
          join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
  ].filter((p): p is string => typeof p === 'string' && p !== '');
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: install Google Chrome or set CHROME_PATH to its executable');
  return found;
}
