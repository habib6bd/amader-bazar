// Copies runtime assets out of node_modules into public/ so the app has no CDN
// dependency at all. Run via `npm run vendor` (also part of `npm run build`).
// The copied files are committed, so a production checkout works offline.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fontDir = 'node_modules/@fontsource/noto-sans-bengali/files';

const copies = [
  ['node_modules/alpinejs/dist/cdn.min.js', 'public/vendor/alpine.min.js'],
  ...['bengali', 'latin'].flatMap((subset) =>
    ['400', '600', '700'].map((weight) => {
      const file = `noto-sans-bengali-${subset}-${weight}-normal.woff2`;
      return [`${fontDir}/${file}`, `public/fonts/${file}`];
    })
  ),
];

for (const [from, to] of copies) {
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, from), dest);
  console.log(`vendored ${to}`);
}
