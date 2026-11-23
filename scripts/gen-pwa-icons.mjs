// Generate the PWA icons (#135) from src/lib/assets/logomark.svg into static/icons/.
// Run: node scripts/gen-pwa-icons.mjs — then commit the PNGs. Uses sharp, which is already
// installed transitively (miniflare); add it as a devDependency if that ever changes.
import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const svg = await readFile(new URL('../src/lib/assets/logomark.svg', import.meta.url));
const out = new URL('../static/icons/', import.meta.url);
await mkdir(out, { recursive: true });

// The logomark is a circle; "any" icons keep it on a transparent square.
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** Render the mark at `inner` px, centred on a `size` px canvas filled with `bg`. */
async function icon(file, size, inner, bg) {
	const mark = await sharp(svg, { density: 72 * Math.ceil(inner / 220) * 2 })
		.resize(inner, inner)
		.png()
		.toBuffer();
	const pad = Math.floor((size - inner) / 2);
	await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
		.composite([{ input: mark, top: pad, left: pad }])
		.png()
		.toFile(fileURLToPath(new URL(file, out)));
	console.log('wrote', file);
}

await icon('icon-192.png', 192, 192, CLEAR);
await icon('icon-512.png', 512, 512, CLEAR);
// Maskable: the mark must sit inside the 80% safe zone, on an opaque background.
await icon('icon-maskable-512.png', 512, 384, WHITE);
// iOS ignores transparency (renders black) — opaque white with a small margin.
await icon('apple-touch-icon.png', 180, 150, WHITE);
