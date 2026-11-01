#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const namesPath = path.join(packageDir, "src", "icon-names.json");
const distPath = path.join(packageDir, "dist", "rc.mjs");

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const resolveOutput = (value) => path.resolve(repoRoot, value);
const mode = arg("--mode", "complete");
const names = JSON.parse(fs.readFileSync(namesPath, "utf8"));
const icons = await import(`${pathToFileURL(distPath).href}?t=${Date.now()}`);

const criticalPattern =
  /Account|User|Organiz|Ai|Alias|AllDocs|Appearance|Apple|Archive|Tidy|Panel|Brain|ColorPicker|Database|Delete|Direction|Discord|Eraser|FileIcon|Filter/;
const panelNames = names.filter((name) => name.endsWith("PanelIcon"));
const panelTypographyCandidates = [
  "BitcoinPanelIcon",
  "CoinPanelIcon",
  "MathPanelIcon",
  "DirectionPanelIcon",
  "DirectionSignPanelIcon",
  "DirectionSign2PanelIcon",
  "DirectionSign3PanelIcon",
  "DirectionSign4PanelIcon",
  "SignalPanelIcon",
  "DiscordPanelIcon",
  "GithubPanelIcon",
  "GooglePanelIcon",
  "YoutubePanelIcon",
  "DrinkPanelIcon",
  "Drink2PanelIcon",
  "TShirtPanelIcon",
  "QrCodePanelIcon",
].filter((name) => icons[name]);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayName(name) {
  return name
    .replace(/Icon$/, "")
    .replace(/Panel$/, " Panel")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}

function iconMarkup(name, size) {
  const Icon = icons[name];
  if (!Icon) return '<span class="missing">missing export</span>';
  return renderToStaticMarkup(
    Icon({ "aria-hidden": "true", width: size, height: size }),
  );
}

function page({ title, subtitle, body, extraClass = "" }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" href="data:,"/>
<title>${escapeHtml(title)}</title>
<style>
:root{--ink:#24334a;--muted:#697386;--line:#d7cab9;--chip:#efe8dd;--focus:#1684ff;--bad:#b42318;}
*{box-sizing:border-box}body{margin:0;padding:38px 42px 64px;background:radial-gradient(circle at 20% 0%,#fff8ec 0,#f5efe5 35%,#efe7db 100%);color:var(--ink);font-family:"Avenir Next",Avenir,"Helvetica Neue",sans-serif}.header{display:flex;align-items:end;justify-content:space-between;gap:24px;position:sticky;top:0;z-index:5;margin:-38px -42px 28px;padding:36px 42px 18px;background:linear-gradient(#f4efe6 78%,rgba(244,239,230,.76));backdrop-filter:blur(12px);border-bottom:1px solid rgba(215,202,185,.65)}h1{font-size:38px;line-height:1;margin:0 0 8px;font-weight:800;letter-spacing:-.04em}.sub{margin:0;color:#5f6877;font-size:17px}.tools{display:flex;gap:10px;align-items:center}.nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.nav a{color:var(--ink);text-decoration:none;font:800 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line);background:#fffaf4;border-radius:999px;padding:9px 11px}input{width:300px;border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:#fffaf4;color:var(--ink);font:600 14px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 8px 22px rgba(32,25,12,.04)}h2{font-size:22px;margin:30px 0 14px;letter-spacing:-.02em}h2 span{color:var(--muted);font-weight:600;font-size:14px;margin-left:6px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:14px}.panel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(138px,1fr));gap:10px}.card{position:relative;min-height:132px;padding:21px 18px 16px;border:1px solid var(--line);border-radius:22px;background:rgba(255,250,241,.86);box-shadow:0 14px 38px rgba(42,30,14,.06);overflow:hidden}.panel-card{min-height:116px;padding:16px 14px 12px;border-radius:18px}.card:hover{outline:2px solid var(--focus);background:#e7f2ff}.glyph{width:40px;height:40px;display:grid;place-items:center;margin-bottom:19px}.panel-card .glyph{width:40px;height:40px;margin-bottom:14px}.glyph svg{width:36px;height:36px}.mini{position:absolute;right:18px;top:18px;width:42px;height:42px;border-radius:14px;background:var(--chip);display:grid;place-items:center;color:#34445b}.panel-card .mini{right:12px;top:16px;width:31px;height:31px;border-radius:10px}.mini svg{width:18px;height:18px}.compact{position:absolute;right:29px;top:70px;width:20px;height:20px;display:grid;place-items:center;color:#34445b}.compact svg{width:14px;height:14px}.panel-card .compact{right:17px;top:56px}.name{font:800 13px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;color:#687385;overflow-wrap:anywhere;letter-spacing:.02em}.panel-card .name{font-size:11px;line-height:1.12}.missing{color:var(--bad);font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}.hidden{display:none!important}.index-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:24px}.index-card{display:block;border:1px solid var(--line);border-radius:24px;padding:22px;background:rgba(255,250,241,.9);color:var(--ink);text-decoration:none;box-shadow:0 14px 38px rgba(42,30,14,.06)}.index-card strong{display:block;font-size:21px;letter-spacing:-.02em;margin-bottom:8px}.index-card span{color:var(--muted)}.suspect-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}.suspect-grid .card{min-height:164px}.suspect-grid .glyph{width:78px;height:78px}.suspect-grid .glyph svg{width:72px;height:72px}.suspect-grid .mini{width:44px;height:44px}.suspect-grid .mini svg{width:22px;height:22px}@media(max-width:720px){body{padding:24px 18px}.header{display:block;margin:-24px -18px 22px;padding:24px 18px 16px}input{width:100%;margin-top:16px}.grid{grid-template-columns:repeat(auto-fill,minmax(142px,1fr))}.card{min-height:138px}.suspect-grid .glyph{width:58px;height:58px}.suspect-grid .glyph svg{width:58px;height:58px}.panel-grid{grid-template-columns:repeat(auto-fill,minmax(126px,1fr))}}
</style></head><body class="${extraClass}"><div class="header"><div><h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(subtitle)}</p><nav class="nav"><a href="./index.html">Index</a><a href="./complete.html">Complete</a><a href="./panels.html">Panels</a><a href="./panel-typography.html">Panel Typography</a></nav></div><div class="tools"><input id="q" placeholder="Filter, e.g. Panel / File / Account" autofocus></div></div>${body}<script>const q=document.querySelector('#q');q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();document.querySelectorAll('.card').forEach(c=>c.classList.toggle('hidden',v&&!c.dataset.name.includes(v)));});</script></body></html>`;
}

function card(name, { panel = false, large = false } = {}) {
  return `<article class="card ${panel ? "panel-card" : ""}" data-name="${escapeHtml(
    name.toLowerCase(),
  )}">
    <div class="glyph">${iconMarkup(name, large ? 72 : panel ? 40 : 52)}</div>
    <div class="mini">${iconMarkup(name, panel ? 18 : large ? 22 : 18)}</div>
    <div class="compact">${iconMarkup(name, 14)}</div>
    <div class="name">${escapeHtml(displayName(name))}</div>
  </article>`;
}

function section(title, sectionNames, options = {}) {
  return `<section><h2>${escapeHtml(title)} <span>${sectionNames.length}</span></h2><div class="${
    options.panel ? "panel-grid" : options.suspect ? "suspect-grid" : "grid"
  }">${sectionNames.map((name) => card(name, options)).join("\n")}</div></section>`;
}

function completeHtml() {
  const criticalNames = names.filter((name) => criticalPattern.test(name));
  return page({
    title: "Myoxus complete icon set",
    subtitle: `${names.length} generated glyphs: reviewed Tabler (MIT) plus Myoxus fallback (AGPL). Every card shows 36px, 18px, and 14px. Critical families are duplicated first.`,
    body: `${section("Critical families", criticalNames)}${section("All glyphs", names)}`,
  });
}

function panelsHtml() {
  return page({
    title: "Myoxus panel icon review",
    subtitle: `${panelNames.length} panel glyphs. Every *PanelIcon is rendered at review, 18px sidebar, and 14px compact sizes.`,
    body: section("All panel glyphs", panelNames, { panel: true }),
  });
}

function panelTypographyHtml() {
  return page({
    title: "Myoxus panel typography review",
    subtitle:
      "Panel routing and text-like candidates. Use this to catch variable letter sizes and standalone glyphs that bypass the panel frame.",
    body: `${section(
      "Letter/text and routing candidates",
      panelTypographyCandidates,
      {
        panel: false,
        large: true,
        suspect: true,
      },
    )}${section("All panel glyphs", panelNames, { panel: true })}`,
  });
}

function indexHtml() {
  return page({
    title: "Myoxus icon QA",
    subtitle:
      "Committed review galleries generated from the current @virgultum/icons dist artifacts.",
    body: `<main class="index-list">
      <a class="index-card" href="./complete.html"><strong>Complete icon set</strong><span>All ${names.length} glyphs with critical families first.</span></a>
      <a class="index-card" href="./panels.html"><strong>Panel icon review</strong><span>All ${panelNames.length} panel icons at large and sidebar sizes.</span></a>
      <a class="index-card" href="./panel-typography.html"><strong>Panel typography review</strong><span>Letter-like and routing-sensitive panel candidates plus the full panel set.</span></a>
    </main>`,
  });
}

function writeFile(outPath, html) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log(outPath);
}

if (mode === "complete") {
  writeFile(
    resolveOutput(arg("--out", "/tmp/myoxus-complete-icon-set.html")),
    completeHtml(),
  );
} else if (mode === "panels") {
  writeFile(
    resolveOutput(arg("--out", "/tmp/myoxus-panel-icon-review.html")),
    panelsHtml(),
  );
} else if (mode === "panel-typography") {
  writeFile(
    resolveOutput(arg("--out", "/tmp/myoxus-panel-typography-review.html")),
    panelTypographyHtml(),
  );
} else if (mode === "review") {
  const outDir = resolveOutput(arg("--out-dir", "/tmp/myoxus-icon-review"));
  writeFile(path.join(outDir, "index.html"), indexHtml());
  writeFile(path.join(outDir, "complete.html"), completeHtml());
  writeFile(path.join(outDir, "panels.html"), panelsHtml());
  writeFile(path.join(outDir, "panel-typography.html"), panelTypographyHtml());
} else {
  console.error(`Unknown gallery mode: ${mode}`);
  console.error("Use --mode complete|panels|panel-typography|review");
  process.exit(1);
}
