// Render the Android launcher icons and splash screens for the APK in apk/,
// from the same bicycle drawing as the web app's icons (tools/make_icons.mjs).
//   npm i playwright && node tools/make_android_icons.mjs
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'apk/android/app/src/main/res');
const GREEN = '#1b7a3e';

const BIKE = `<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="5.4" cy="17.4" r="3.4"/><circle cx="18.6" cy="17.4" r="3.4"/>
  <path d="M5.4 17.4 10.2 7.6h3.6l4.8 9.8"/><path d="M10.2 7.6 8.6 4.2H6.2"/>
  <circle cx="12" cy="17.4" r="1" fill="#fff" stroke="none"/></g>`;

// The bike drawing, scaled to `size` px and centred in a w x h canvas.
const bikeAt = (w, h, size) =>
  `<g transform="translate(${(w - size) / 2} ${(h - size) / 2}) scale(${size / 24})">${BIKE}</g>`;

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

const gradient = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#23924c"/><stop offset="1" stop-color="#14602f"/></linearGradient></defs>`;

const pngSize = (file) => {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const jobs = [];
for (const dir of readdirSync(RES)) {
  const d = join(RES, dir);
  for (const [name, make] of [
    // Pre-Android-8 launchers: a rounded square, and a circle.
    ['ic_launcher.png', (s) => svg(s, s, gradient + `<rect width="${s}" height="${s}" rx="${s * 0.22}" fill="url(#g)"/>` + bikeAt(s, s, s * 0.74))],
    ['ic_launcher_round.png', (s) => svg(s, s, gradient + `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="url(#g)"/>` + bikeAt(s, s, s * 0.62))],
    // Adaptive icon foreground: the launcher masks the outer third, so the
    // bike stays inside the central safe zone on a transparent layer.
    ['ic_launcher_foreground.png', (s) => svg(s, s, bikeAt(s, s, s * 0.5))],
    // Launch screen: the brand green with the bike in the middle.
    ['splash.png', (w, h) => svg(w, h, `<rect width="${w}" height="${h}" fill="${GREEN}"/>` + bikeAt(w, h, Math.min(w, h) * 0.34))],
  ]) {
    const f = join(d, name);
    if (existsSync(f)) jobs.push([f, make]);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, make] of jobs) {
  const [w, h] = pngSize(file);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;background:transparent">${make(w, h)}</body>`);
  writeFileSync(file, await page.screenshot({ omitBackground: true }));
}
await browser.close();

// Adaptive icon background layer.
writeFileSync(join(RES, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${GREEN}</color>\n</resources>\n`);
console.log(`rendered ${jobs.length} images`);
