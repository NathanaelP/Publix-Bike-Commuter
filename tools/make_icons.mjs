// Render the app icons from an inline SVG using headless Chromium.
//   NODE_PATH=$(npm root -g) node tools/make_icons.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const svg = (size, maskable) => {
  // Maskable icons get cropped to a circle by Android, so pad the artwork in.
  const pad = maskable ? 0.20 : 0.115;
  const r = maskable ? size / 2 : size * 0.22;
  const s = size * (1 - pad * 2);
  const o = size * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#23924c"/><stop offset="1" stop-color="#14602f"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
    <g transform="translate(${o} ${o}) scale(${s / 24})"
       fill="none" stroke="#fff" stroke-width="1.7"
       stroke-linecap="round" stroke-linejoin="round">
      <circle cx="5.4" cy="17.4" r="3.4"/>
      <circle cx="18.6" cy="17.4" r="3.4"/>
      <path d="M5.4 17.4 10.2 7.6h3.6l4.8 9.8"/>
      <path d="M10.2 7.6 8.6 4.2H6.2"/>
      <circle cx="12" cy="17.4" r="1" fill="#fff" stroke="none"/>
    </g>
  </svg>`;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox']
});
const page = await browser.newPage();

for (const [name, size, maskable] of [
  ['icons/icon-192.png', 192, false],
  ['icons/icon-512.png', 512, false],
  ['icons/maskable-512.png', 512, true],
  ['icons/favicon-64.png', 64, false]
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0">${svg(size, maskable)}</body>`,
    { waitUntil: 'load' });
  writeFileSync(name, await page.screenshot({ omitBackground: true }));
  console.log('wrote', name, size + 'px' + (maskable ? ' (maskable)' : ''));
}

await browser.close();
