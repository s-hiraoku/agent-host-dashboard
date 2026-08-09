import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const assetDirectory = new URL("../dist/assets/", import.meta.url);
const entries = await readdir(assetDirectory);
const measured = await Promise.all(
  entries
    .filter((name) => name.endsWith(".js") || name.endsWith(".css"))
    .map(async (name) => {
      const bytes = await readFile(join(assetDirectory.pathname, name));
      return { name, raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
    }),
);

if (!measured.some((asset) => asset.name.endsWith(".js"))) {
  throw new Error("The production build did not emit a JavaScript asset.");
}

const totals = measured.reduce(
  (current, asset) => ({ raw: current.raw + asset.raw, gzip: current.gzip + asset.gzip }),
  { raw: 0, gzip: 0 },
);
const budgets = { raw: 400 * 1024, gzip: 110 * 1024 };
console.log(JSON.stringify({ assets: measured, totals, budgets }, null, 2));

if (totals.raw > budgets.raw || totals.gzip > budgets.gzip) {
  throw new Error(`Production assets exceeded the budget: ${totals.raw} raw / ${totals.gzip} gzip bytes.`);
}
