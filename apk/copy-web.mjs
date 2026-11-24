// Copy the web app from the repository root into www/, the folder Capacitor
// bundles into the APK. Everything the app loads at runtime ships inside the
// APK, so routes, directions and store data all work with no signal.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'www');

const ENTRIES = [
  'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'sw.js',
  'vendor', 'data', 'profiles', 'icons',
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of ENTRIES) {
  const src = join(root, entry);
  if (!existsSync(src)) throw new Error(`missing ${entry} at the repository root`);
  cpSync(src, join(out, entry), { recursive: true });
}
console.log(`copied ${ENTRIES.length} entries into www/`);
