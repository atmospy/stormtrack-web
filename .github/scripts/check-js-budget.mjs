#!/usr/bin/env node
// Enforces the initial-JS budget from docs/PLAN.md: <= 150 kB gzip, EXCLUDING the map library.
//
// "Initial JS" = every JS file reachable from the entry HTML through <script src>,
// <link rel=modulepreload>, inline `import("...")`/`import "..."` in the HTML, and static
// `import ... from "./x.js"` edges inside those files. Dynamic import() inside chunks is
// lazy by definition and is not counted. Chunks identified as the map library are reported
// but excluded. Usage: node check-js-budget.mjs [buildDir] [--budget-kb 150]
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const buildDir = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--budget-kb") ?? process.env.BUILD_DIR ?? "apps/web/build");
const budgetBytes = Number(flag("--budget-kb", process.env.JS_BUDGET_KB ?? "150")) * 1000;
const MAP_LIB = /maplibre|mapbox-gl/i; // file name, or banner/identifying strings inside the chunk
const MAP_LIB_CONTENT = /MapLibre GL JS|\bmaplibregl\b/; // banner/global; only trusted on big chunks

const fail = (m) => { console.error(`::error::${m}`); process.exit(1); };
if (!existsSync(buildDir)) fail(`build dir not found: ${buildDir} (run the web build first)`);

const entries = ["index.html", "200.html", "404.html"].map((f) => path.join(buildDir, f)).filter(existsSync);
if (!entries.length) fail(`no index.html/200.html in ${buildDir}`);

const urlToFile = (u, from) => {
  const clean = u.split("#")[0].split("?")[0];
  if (/^(https?:)?\/\//.test(clean)) return null; // external
  return clean.startsWith("/") ? path.join(buildDir, clean) : path.resolve(path.dirname(from), clean);
};

const seen = new Map(); // file -> {gz, raw, isMap}
function visit(file) {
  if (seen.has(file) || !existsSync(file) || !/\.m?js$/.test(file)) return;
  const buf = readFileSync(file);
  const text = buf.toString("utf8");
  const isMap = MAP_LIB.test(path.basename(file)) || (buf.length > 200_000 && MAP_LIB_CONTENT.test(text));
  seen.set(file, { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length, isMap });
  // static imports only: `import x from "./a.js"`, `import "./a.js"`, `export * from "./a.js"`
  for (const m of text.matchAll(/(?:\bimport|\bexport)\s*(?:[^'"()]*?\bfrom\s*)?["']([^"']+\.m?js)["']/g)) {
    const f = urlToFile(m[1], file);
    if (f) visit(f);
  }
}

for (const entry of entries.slice(0, 1)) {
  const html = readFileSync(entry, "utf8");
  const refs = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g),
    ...html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]*href=["']([^"']+)["']/g),
    ...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']modulepreload["']/g),
    ...html.matchAll(/\bimport\s*\(?\s*["']([^"']+\.m?js)["']/g), // SvelteKit inline bootstrap
  ];
  for (const m of refs) { const f = urlToFile(m[1], entry); if (f) visit(f); }
}

if (!seen.size) fail("no JS reachable from the entry HTML — is the build output the static adapter's?");

let counted = 0, excluded = 0;
const rows = [...seen].map(([f, v]) => ({ f: path.relative(buildDir, f), ...v })).sort((a, b) => b.gz - a.gz);
for (const r of rows) { if (r.isMap) excluded += r.gz; else counted += r.gz; }
const kb = (n) => (n / 1000).toFixed(1).padStart(7) + " kB";
console.log(`Initial JS (gzip) reachable from ${path.relative(process.cwd(), entries[0])}`);
for (const r of rows) console.log(`${kb(r.gz)}  ${r.isMap ? "[map lib, excluded] " : ""}${r.f}`);
console.log(`\ncounted ${kb(counted)}  budget ${kb(budgetBytes)}  (map library excluded: ${kb(excluded)})`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Initial JS budget\n\n| | gzip |\n|---|---|\n| counted | **${(counted / 1000).toFixed(1)} kB** |\n| budget | ${(budgetBytes / 1000).toFixed(0)} kB |\n| map lib (excluded) | ${(excluded / 1000).toFixed(1)} kB |\n`);
}
if (counted > budgetBytes) fail(`initial JS ${(counted / 1000).toFixed(1)} kB gzip exceeds budget ${(budgetBytes / 1000).toFixed(0)} kB (map library excluded)`);
console.log("budget OK");
