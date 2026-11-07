/**
 * One-off: pull the OFL webfonts the GUI ships with into ui/public/fonts and
 * write the local @font-face sheet. Run once; the repo carries the result.
 *
 * Only the generated files (*.woff2 and fonts.css) are replaced. OFL.txt and
 * README.md in the same directory are kept: the licence text has to ship with
 * the fonts.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `ui/public/fonts`, resolved from this script's own location. */
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** @type {{family:string, slug:string, weights:number[], latinOnly:boolean}[]} */
const FAMILIES = [
  { family: "Zen Kaku Gothic New", slug: "zen-kaku-gothic-new", weights: [400, 700], latinOnly: false },
  { family: "M PLUS 1 Code", slug: "m-plus-1-code", weights: [400, 500], latinOnly: true },
];

function coversLatin(range) {
  // This face renders paths, ids and numbers — all ASCII. Google's `latin`,
  // `latin-ext` and `vietnamese` subsets cover that completely; the ~116 CJK
  // subsets would be dead weight, since Japanese text is set in Zen Kaku.
  return /U\+0000-00FF|U\+0100-02BA|U\+0102-0103/.test(range);
}

function parseFaces(css) {
  const faces = [];
  const re = /@font-face\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const block = m[1];
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
    const url = /url\((https:[^)]+)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
    if (weight && url && range) faces.push({ weight: Number(weight), url, range: range.trim() });
  }
  return faces;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const name of await readdir(OUT_DIR)) {
    if (name.endsWith(".woff2") || name === "fonts.css") {
      await rm(path.join(OUT_DIR, name), { force: true });
    }
  }

  const sheet = [
    "/*",
    " * Local webfonts (SIL Open Font License 1.1), fetched from Google Fonts and",
    " * committed to the repository. The console is served by its local server",
    " * under a CSP that forbids remote loads, so nothing here may reference a",
    " * network URL. Regenerate with tools/fetch-fonts.mjs.",
    " *",
    " *  Zen Kaku Gothic New — Japanese body and label text",
    " *  M PLUS 1 Code       — numerals, paths, terminal labels (Latin subset only)",
    " */",
    "",
  ];

  for (const { family, slug, weights, latinOnly } of FAMILIES) {
    const url =
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}` +
      `:wght@${weights.join(";")}&display=block`;
    const css = await (await fetch(url, { headers: { "User-Agent": UA } })).text();
    let faces = parseFaces(css);
    if (latinOnly) faces = faces.filter((f) => coversLatin(f.range));
    console.log(`${family}: ${faces.length} subsets`);

    const byWeight = new Map();
    let downloaded = 0;
    for (const face of faces) {
      const n = (byWeight.get(face.weight) ?? 0) + 1;
      byWeight.set(face.weight, n);
      const file = `${slug}-${face.weight}-${String(n).padStart(3, "0")}.woff2`;
      const res = await fetch(face.url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`${face.url}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(OUT_DIR, file), buf);
      downloaded += buf.length;
      sheet.push(
        "@font-face {",
        `  font-family: "${family}";`,
        "  font-style: normal;",
        `  font-weight: ${face.weight};`,
        "  font-display: block;",
        `  src: url("/fonts/${file}") format("woff2");`,
        `  unicode-range: ${face.range};`,
        "}",
      );
    }
    console.log(`  ${(downloaded / 1024 / 1024).toFixed(2)} MB`);
  }

  sheet.push("");
  await writeFile(path.join(OUT_DIR, "fonts.css"), sheet.join("\n"), "utf8");
}

await main();
