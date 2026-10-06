// Generates 1200x630 social preview cards (og:image) as PNG.
//
//   node tools/og-image.ts _posts/2026-10-06-my-post.md   -> assets/images/og-my-post.png
//   node tools/og-image.ts --default                      -> assets/images/og-default.png
//
// Requires Node 23.6+ (runs .ts directly) and rsvg-convert (`brew install librsvg`).
// Front matter is read with a simple line parser: only single-line `key: value` fields.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const WIDTH = 1200;
const HEIGHT = 630;
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const SITE_HOST = "jmilkiewicz.github.io";
const IMAGES_DIR = "assets/images";

type Card = {
  kicker: string;
  title: string;
};

function readFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_]+):\s*(.+)$/.exec(line);
    if (match) {
      fields[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return fields;
}

function readFrontMatter(postPath: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(postPath, "utf8"));
  if (!match) {
    throw new Error(`${postPath}: no front matter found`);
  }
  return readFields(match[1]);
}

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSvg({ kicker, title }: Card): string {
  // Long titles get a smaller font so they still fit in about four lines.
  const [fontSize, maxChars] = title.length < 70 ? [64, 30] : [54, 36];
  const lines = wrap(title, maxChars).slice(0, 5);
  const lineHeight = Math.round(fontSize * 1.22);
  const top = HEIGHT / 2 - Math.floor((lines.length * lineHeight) / 2) + fontSize / 2 + 10;
  const tspans = lines
    .map((line, i) => `<tspan x="96" y="${top + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#15171a"/>
  <rect width="16" height="${HEIGHT}" fill="#6cb6ff"/>
  <text x="96" y="110" font-family="${FONT}" font-size="30" font-weight="600" fill="#6cb6ff">${escapeXml(kicker)}</text>
  <text font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="#e4e6e9">${tspans}</text>
  <text x="96" y="560" font-family="${FONT}" font-size="28" fill="#9aa3ad">${SITE_HOST}</text>
</svg>`;
}

function cardForPost(postPath: string): Card {
  const fields = readFrontMatter(postPath);
  if (!fields.title) {
    throw new Error(`${postPath}: front matter has no title`);
  }
  const kicker = fields.series
    ? [fields.series, fields.series_part && `Part ${fields.series_part}`].filter(Boolean).join(" · ")
    : SITE_HOST;
  return { kicker, title: fields.title };
}

function cardForSite(): Card {
  const config = readFields(readFileSync("_config.yml", "utf8"));
  return { kicker: config.title, title: config.description };
}

function main(args: string[]): void {
  const [target] = args;
  if (!target) {
    console.error("Usage: node tools/og-image.ts <_posts/YYYY-MM-DD-slug.md | --default>");
    process.exit(1);
  }

  const isDefault = target === "--default";
  const card = isDefault ? cardForSite() : cardForPost(target);
  const slug = isDefault ? "default" : basename(target, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const output = `${IMAGES_DIR}/og-${slug}.png`;

  execFileSync("rsvg-convert", ["-w", `${WIDTH}`, "-h", `${HEIGHT}`, "-o", output], {
    input: renderSvg(card),
  });

  console.log(`Wrote ${output}`);
  if (!isDefault) {
    console.log(`Add to the post's front matter:\nimage: /${output}`);
  }
}

main(process.argv.slice(2));
