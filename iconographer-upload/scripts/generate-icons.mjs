/* Rasterizes icon-source.jpg into every PNG size the manifest and iOS need.
   Run with:  npm run gen:icons
   Requires sharp (devDependency). Outputs to public/icons/.

   Standard icons are a center "cover" crop of the source photo, filled edge to
   edge — normal for a photo-based app icon. Maskable icons additionally shrink
   the same crop to ~80% on a solid background, so iOS/Android's circular or
   rounded-square mask doesn't clip the subject.
*/
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(__dirname, 'icon-source.jpg');
const OUT = join(__dirname, '..', 'public', 'icons');

// Matches the manifest's background_color / the app's dark theme, so the
// letterboxing around maskable icons doesn't clash with either home screen.
const MASKABLE_BG = { r: 0x1a, g: 0x14, b: 0x10 };
const MASKABLE_SAFE_RATIO = 0.8;

async function squareCrop(size) {
  return sharp(SOURCE)
    .rotate() // auto-orient from EXIF before anything else touches pixel coords
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}

async function maskableIcon(size) {
  const inner = Math.round(size * MASKABLE_SAFE_RATIO);
  const cropped = await squareCrop(inner);
  return sharp({
    create: { width: size, height: size, channels: 3, background: MASKABLE_BG }
  })
    .composite([{ input: cropped, gravity: 'centre' }])
    .png()
    .toBuffer();
}

const tasks = [
  // Manifest "any" icons
  { name: 'icon-16.png', size: 16, kind: 'standard' },
  { name: 'icon-32.png', size: 32, kind: 'standard' },
  { name: 'icon-192.png', size: 192, kind: 'standard' },
  { name: 'icon-256.png', size: 256, kind: 'standard' },
  { name: 'icon-384.png', size: 384, kind: 'standard' },
  { name: 'icon-512.png', size: 512, kind: 'standard' },
  // Maskable
  { name: 'icon-192-maskable.png', size: 192, kind: 'maskable' },
  { name: 'icon-512-maskable.png', size: 512, kind: 'maskable' },
  // Apple touch icons (opaque background required by iOS)
  { name: 'apple-touch-icon.png', size: 180, kind: 'standard' },
  { name: 'apple-touch-icon-180.png', size: 180, kind: 'standard' },
  { name: 'apple-touch-icon-167.png', size: 167, kind: 'standard' },
  { name: 'apple-touch-icon-152.png', size: 152, kind: 'standard' }
];

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const t of tasks) {
    const buf = t.kind === 'maskable' ? await maskableIcon(t.size) : await squareCrop(t.size);
    await sharp(buf).toFile(join(OUT, t.name));
    console.log('✓', t.name);
  }
  console.log(`\nGenerated ${tasks.length} icons in public/icons/ from ${SOURCE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
