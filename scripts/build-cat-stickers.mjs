/**
 * One-off generator: builds the bundled "cats" sticker pack.
 *
 * Source: Twemoji cat-face emoji (CC-BY 4.0, Twitter/jdecked fork) — chosen
 * because each cat face already encodes a distinct EMOTION, which is exactly
 * what an agent needs to pick a sticker for a moment. Rendered here to
 * WhatsApp's sticker spec (512x512 webp, transparent) and committed as assets,
 * so the runtime needs no image library at all.
 *
 * Run: node scripts/build-cat-stickers.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "stickers", "cats");

// mood -> twemoji codepoint. Moods match the vocabulary agents use.
const CATS = [
  { mood: "risa", cp: "1f639", emoji: "😹", desc: "gato llorando de risa" },
  { mood: "carino", cp: "1f63b", emoji: "😻", desc: "gato con ojos de corazón" },
  { mood: "saludo", cp: "1f63a", emoji: "😺", desc: "gato sonriente" },
  { mood: "ok", cp: "1f638", emoji: "😸", desc: "gato sonriendo con ojos felices" },
  { mood: "travieso", cp: "1f63c", emoji: "😼", desc: "gato con sonrisa pícara" },
  { mood: "beso", cp: "1f63d", emoji: "😽", desc: "gato dando un beso" },
  { mood: "sorpresa", cp: "1f640", emoji: "🙀", desc: "gato asustado/sorprendido" },
  { mood: "disculpa", cp: "1f63f", emoji: "😿", desc: "gato llorando (pena, disculpa)" },
  { mood: "molesto", cp: "1f63e", emoji: "😾", desc: "gato enfadado" },
  { mood: "neutral", cp: "1f431", emoji: "🐱", desc: "carita de gato" },
];

const svgUrl = (cp) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${cp}.svg`;

mkdirSync(OUT_DIR, { recursive: true });
const manifest = [];

for (const cat of CATS) {
  const res = await fetch(svgUrl(cat.cp));
  if (!res.ok) {
    console.error(`✗ ${cat.mood} (${cat.cp}): HTTP ${res.status}`);
    continue;
  }
  const svg = Buffer.from(await res.arrayBuffer());
  // WhatsApp stickers: 512x512, transparent, webp. Contain + padding keeps the
  // art centered without cropping.
  const webp = await sharp(svg, { density: 512 })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, effort: 6 })
    .toBuffer();
  const file = `${cat.mood}.webp`;
  writeFileSync(join(OUT_DIR, file), webp);
  manifest.push({ id: `cats:${cat.mood}`, mood: cat.mood, file, emoji: cat.emoji, description: cat.desc, bytes: webp.length });
  console.log(`✓ ${cat.mood.padEnd(9)} ${cat.emoji}  ${String(webp.length).padStart(6)} bytes`);
}

writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify(
    {
      pack: "cats",
      title: "Gatitos",
      source: "Twemoji (https://github.com/jdecked/twemoji)",
      license: "CC-BY 4.0 — graphics by Twitter, Inc and other contributors",
      stickers: manifest,
    },
    null,
    2
  )
);
console.log(`\n${manifest.length} stickers → ${OUT_DIR}`);
