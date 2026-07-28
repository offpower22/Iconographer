/* Rasterizes the app emblem into every PNG size the manifest and iOS need.
   Run with:  npm run gen:icons
   Requires sharp (devDependency). Outputs to public/icons/.
*/
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'icons');

// Full-bleed emblem (used for "any" icons, apple-touch, favicons).
function emblemSVG(size) {
  const s = size;
  const c = s / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <defs>
      <radialGradient id="bg" cx="50%" cy="42%" r="70%">
        <stop offset="0%" stop-color="#2a2118"/>
        <stop offset="100%" stop-color="#15100b"/>
      </radialGradient>
    </defs>
    <rect width="${s}" height="${s}" fill="url(#bg)"/>
    <circle cx="${c}" cy="${c}" r="${s * 0.30}" fill="none" stroke="#a67c34" stroke-width="${s * 0.028}"/>
    <circle cx="${c}" cy="${c}" r="${s * 0.395}" fill="none" stroke="#6b5323" stroke-width="${s * 0.016}" stroke-dasharray="${s * 0.03} ${s * 0.06}"/>
    <path d="M${c} ${s * 0.21}V${s * 0.79}M${s * 0.21} ${c}H${s * 0.79}" stroke="#a67c34" stroke-width="${s * 0.022}" stroke-linecap="round" opacity="0.5"/>
    <circle cx="${c}" cy="${c}" r="${s * 0.07}" fill="#d2a85f"/>
  </svg>`;
}

// Maskable variant: same emblem but scaled into the ~80% safe zone with a
// solid, edge-to-edge background so platform masks never clip content.
function maskableSVG(size) {
  const s = size;
  const c = s / 2;
  const r = s * 0.30 * 0.8; // shrink the emblem for the safe zone
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <rect width="${s}" height="${s}" fill="#1a1410"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#a67c34" stroke-width="${s * 0.024}"/>
    <circle cx="${c}" cy="${c}" r="${r * 1.3}" fill="none" stroke="#6b5323" stroke-width="${s * 0.013}" stroke-dasharray="${s * 0.026} ${s * 0.05}"/>
    <path d="M${c} ${c - r * 1.1}V${c + r * 1.1}M${c - r * 1.1} ${c}H${c + r * 1.1}" stroke="#a67c34" stroke-width="${s * 0.019}" stroke-linecap="round" opacity="0.5"/>
    <circle cx="${c}" cy="${c}" r="${s * 0.058}" fill="#d2a85f"/>
  </svg>`;
}

const tasks = [
  // Manifest "any" icons
  { name: 'icon-16.png', size: 16, kind: 'emblem' },
  { name: 'icon-32.png', size: 32, kind: 'emblem' },
  { name: 'icon-192.png', size: 192, kind: 'emblem' },
  { name: 'icon-256.png', size: 256, kind: 'emblem' },
  { name: 'icon-384.png', size: 384, kind: 'emblem' },
  { name: 'icon-512.png', size: 512, kind: 'emblem' },
  // Maskable
  { name: 'icon-192-maskable.png', size: 192, kind: 'maskable' },
  { name: 'icon-512-maskable.png', size: 512, kind: 'maskable' },
  // Apple touch icons (opaque background required by iOS)
  { name: 'apple-touch-icon.png', size: 180, kind: 'emblem' },
  { name: 'apple-touch-icon-180.png', size: 180, kind: 'emblem' },
  { name: 'apple-touch-icon-167.png', size: 167, kind: 'emblem' },
  { name: 'apple-touch-icon-152.png', size: 152, kind: 'emblem' }
];

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const t of tasks) {
    const svg = t.kind === 'maskable' ? maskableSVG(t.size) : emblemSVG(t.size);
    await sharp(Buffer.from(svg)).png().toFile(join(OUT, t.name));
    console.log('✓', t.name);
  }
  console.log(`\nGenerated ${tasks.length} icons in public/icons/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
