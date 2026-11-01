#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as tablerIcons from "@tabler/icons-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { analyzeIconUsage } from "../../virgultum/icons/scripts/analyze-icon-usage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const decisionsPath = path.join(
  repoRoot,
  "output/icon-review",
  "tabler-decisions-open-remaining.json",
);
const host = "127.0.0.1";
const port = Number(process.env.MYOXUS_ICON_REVIEW_PORT ?? 4177);
const statuses = new Set(["accept", "change", "keep", "custom", "remove"]);

const proposed = {
  MyoxusIcon: [
    "IconHexagonLetterM",
    "Produktlogo; Tabler kann nur einen neutralen Platzhalter liefern.",
  ],
  AiThinkingIcon: [
    "IconMessageChatbot",
    "Kombiniert KI und laufenden Denkzustand.",
  ],
  ArrowDownSmallPlusIcon: [
    "IconArrowDown",
    "Tabler verliert das zusätzliche Plus.",
  ],
  ArrowLeftSmallPlusIcon: [
    "IconArrowLeft",
    "Tabler verliert das zusätzliche Plus.",
  ],
  ArrowRightSmallPlusIcon: [
    "IconArrowRight",
    "Aktiv genutzt; Tabler verliert das zusätzliche Plus.",
  ],
  ArrowShapeIcon: [
    "IconArrowGuide",
    "Formobjekt oder Richtungsaktion sind nicht eindeutig.",
  ],
  ArrowUpSmallPlusIcon: [
    "IconArrowUp",
    "Tabler verliert das zusätzliche Plus.",
  ],
  AutoTidyUpIcon: [
    "IconWand",
    "Automatisches Anordnen ist nur metaphorisch abbildbar.",
  ],
  BulletedList01Icon: [
    "IconList",
    "Vier historische Listenvarianten teilen sich zu wenige Tabler-Glyphen.",
  ],
  BulletedList02Icon: [
    "IconListDetails",
    "Vier historische Listenvarianten teilen sich zu wenige Tabler-Glyphen.",
  ],
  BulletedList03Icon: [
    "IconListLetters",
    "Vier historische Listenvarianten teilen sich zu wenige Tabler-Glyphen.",
  ],
  BulletedList04Icon: [
    "IconListNumbers",
    "Vier historische Listenvarianten teilen sich zu wenige Tabler-Glyphen.",
  ],
  ClaudeDuotoneIcon: ["IconSparkles", "Claude-Marke fehlt in Tabler."],
  ClientIcon: [
    "IconDeviceDesktop",
    "Client kann Benutzer, Gerät oder API-Client bedeuten.",
  ],
  CloudBubbleIcon: [
    "IconMessageCircle",
    "Cloud- und Nachrichtenmetapher lassen sich nicht gemeinsam erhalten.",
  ],
  DirectionSign2PanelIcon: [
    "IconDirectionSign",
    "Historische dekorative Variante ohne 1:1-Gegenstück.",
  ],
  DirectionSign3PanelIcon: [
    "IconSignLeft",
    "Historische dekorative Variante ohne 1:1-Gegenstück.",
  ],
  DirectionSign4PanelIcon: [
    "IconSignRight",
    "Historische dekorative Variante ohne 1:1-Gegenstück.",
  ],
  DropCursorDuotoneIcon: [
    "IconPointerDown",
    "Könnte Zeigerzustand oder Drag-and-drop-Aktion bedeuten.",
  ],
  DropCursorIcon: [
    "IconPointerDown",
    "Könnte Zeigerzustand oder Drag-and-drop-Aktion bedeuten.",
  ],
  EmptyIcon: [
    "IconX",
    "Wird aktiv als Schließen-Symbol benutzt; der Exportname ist irreführend.",
  ],
  FileIconAviIcon: [
    "IconVideo",
    "Format AVI geht im generischen Video-Symbol verloren.",
  ],
  FileIconDmgIcon: [
    "IconBrandApple",
    "DMG-Dateiformat hat kein Tabler-Gegenstück.",
  ],
  FileIconExeIcon: [
    "IconBinary",
    "EXE-Dateiformat hat kein Tabler-Gegenstück.",
  ],
  FileIconGifIcon: [
    "IconPhoto",
    "Format GIF geht im generischen Bildsymbol verloren.",
  ],
  FileIconImgIcon: [
    "IconPhoto",
    "IMG kann Bild- oder Datenträgerformat bedeuten.",
  ],
  FileIconJavaIcon: [
    "IconFileCode",
    "Java-Dateiformat und Java-Marke fehlen in Tabler.",
  ],
  FileIconJsonIcon: [
    "IconBraces",
    "JSON-Dateiformat wird nur metaphorisch dargestellt.",
  ],
  FileIconMkvIcon: [
    "IconVideo",
    "Format MKV geht im generischen Video-Symbol verloren.",
  ],
  FileIconMp3Icon: [
    "IconFileMusic",
    "Format MP3 geht im generischen Audiosymbol verloren.",
  ],
  FileIconMp4Icon: [
    "IconVideo",
    "Format MP4 geht im generischen Video-Symbol verloren.",
  ],
  FileIconMpegIcon: [
    "IconVideo",
    "Format MPEG geht im generischen Video-Symbol verloren.",
  ],
  FileIconTiffIcon: [
    "IconPhoto",
    "Format TIFF geht im generischen Bildsymbol verloren.",
  ],
  FileIconWavIcon: [
    "IconFileMusic",
    "Format WAV geht im generischen Audiosymbol verloren.",
  ],
  FileIconWebpIcon: [
    "IconPhoto",
    "Format WebP geht im generischen Bildsymbol verloren.",
  ],
  HardDriveIcon: [
    "IconServer",
    "Tabler hat kein eindeutiges Festplatten-/Datenträger-Glyph.",
  ],
  IssueIcon: [
    "IconAlertCircle",
    "Issue kann Fehler, Warnung oder allgemeines Ticket bedeuten.",
  ],
  LinearLogoDuotoneIcon: ["IconLetterL", "Linear-Marke fehlt in Tabler."],
  LinearLogoIcon: ["IconLetterL", "Linear-Marke fehlt in Tabler."],
  NewXxxEdgelessIcon: [
    "IconFileInfinity",
    "Neues Edgeless-Dokument braucht Produktmetapher plus Hinzufügen-Zustand.",
  ],
  NoteShadowDuotoneIcon: [
    "IconNote",
    "Schatten-/Stilzustand geht in Tabler verloren.",
  ],
  OctobaseIcon: [
    "IconDatabase",
    "Produktspezifisches Octobase-Zeichen fehlt in Tabler.",
  ],
  ParallelogramIcon: [
    "IconShape",
    "Tabler hat keine Parallelogramm-Grundform.",
  ],
  PaymentIcon: [
    "IconCreditCard",
    "Obsoleter Monetarisierungsexport; eher entfernen als neu beleben.",
  ],
  PenThickIcon: ["IconPencil", "Strichstärke geht im Tabler-Glyph verloren."],
  PenThickLeftIcon: [
    "IconPencil",
    "Strichstärke und Richtung gehen im Tabler-Glyph verloren.",
  ],
  PenThinIcon: ["IconPencil", "Strichstärke geht im Tabler-Glyph verloren."],
  RadiantIcon: [
    "IconTopologyStar3",
    "Aktiv als radiales Mindmap-Layout; nur angenähert.",
  ],
  ReadwiseIcon: ["IconBookmark", "Readwise-Marke fehlt in Tabler."],
  ReadwiseLogoDuotoneIcon: ["IconBookmark", "Readwise-Marke fehlt in Tabler."],
  ReauthenticationIcon: [
    "IconLockExclamation",
    "Erneute Anmeldung kombiniert Schloss, Warnung und Wiederholung.",
  ],
  ReleaseFromGroupIcon: [
    "IconBoxOff",
    "Aktive Ungroup-Aktion; Tabler hat kein echtes Ungroup-Glyph.",
  ],
  ResizeTidyUpIcon: [
    "IconWand",
    "Automatisches Größenangleichen ist nur metaphorisch abbildbar.",
  ],
  RightLayoutIcon: [
    "IconBinaryTree2",
    "Aktiv als rechtsgerichtetes Mindmap-Layout; Richtung fehlt im Kandidaten.",
  ],
  ShortPantsPanelIcon: [
    "IconHanger",
    "Kleidungsart geht im generischen Symbol verloren.",
  ],
  SiblingNodeIcon: [
    "IconHierarchy2",
    "Aktive Mindmap-Aktion; Geschwisterbeziehung ist nicht eindeutig sichtbar.",
  ],
  SkirtPanelIcon: [
    "IconHanger",
    "Kleidungsart geht im generischen Symbol verloren.",
  ],
  SnowMountainPanelIcon: [
    "IconMountain",
    "Schnee-Merkmal geht im generischen Bergsymbol verloren.",
  ],
  SoloViewIcon: [
    "IconUser",
    "Solo kann Einzelbenutzer, Fokus oder isolierte Ansicht bedeuten.",
  ],
  StopAiIcon: [
    "IconPlayerStop",
    "Aktiv genutzt; KI-Merkmal geht im Stop-Symbol verloren.",
  ],
  SubNodeIcon: [
    "IconHierarchy3",
    "Aktive Mindmap-Aktion; Kindbeziehung ist nur angenähert.",
  ],
  VerticalCylinderIcon: [
    "IconCylinder",
    "Vertikale Ausrichtung geht im Tabler-Glyph verloren.",
  ],
  ViewBarIcon: [
    "IconAspectRatio",
    "Aktiv für „an Ansicht anpassen“; Name und Nutzung weichen ab.",
  ],
  ZendeskDuotoneIcon: ["IconMessageCircle", "Zendesk-Marke fehlt in Tabler."],
  ZendeskIcon: ["IconMessageCircle", "Zendesk-Marke fehlt in Tabler."],
};

const [allNames, top200, obvious, openReview] = await Promise.all([
  fs
    .readFile(
      path.join(repoRoot, "virgultum/icons/src/icon-names.json"),
      "utf8",
    )
    .then(JSON.parse),
  fs
    .readFile(
      path.join(repoRoot, "virgultum/icons/src/mappings/tabler-top-200.json"),
      "utf8",
    )
    .then(JSON.parse),
  fs
    .readFile(
      path.join(repoRoot, "virgultum/icons/src/mappings/tabler-obvious.json"),
      "utf8",
    )
    .then(JSON.parse),
  fs
    .readFile(
      path.join(
        repoRoot,
        "virgultum/icons/src/mappings/tabler-open-review.json",
      ),
      "utf8",
    )
    .then(JSON.parse),
]);
const mapped = new Set([
  ...top200.icons.map(({ myoxus }) =>
    myoxus.endsWith("Icon") ? myoxus : `${myoxus}Icon`,
  ),
  ...obvious.icons.map(({ myoxus }) => myoxus),
  ...openReview.review.decisions.map(({ myoxus }) => myoxus),
]);
const unresolved = allNames.filter((name) => !mapped.has(name));
if (
  unresolved.length !== openReview.scope.unresolvedCount ||
  unresolved.some((name) => !proposed[name])
) {
  throw new Error(
    `Review candidates do not match unresolved mappings: ${unresolved.filter((name) => !proposed[name]).join(", ")}`,
  );
}

const myoxusIcons = await import(
  `${pathToFileURL(path.join(repoRoot, "virgultum/icons/dist/rc.mjs")).href}?open-review`
);
const usageAnalysis = analyzeIconUsage();
const usageByName = new Map(
  usageAnalysis.icons.map((icon) => [icon.name, icon]),
);

function markup(Component) {
  return renderToStaticMarkup(
    createElement(Component, {
      "aria-hidden": "true",
      focusable: "false",
      width: 28,
      height: 28,
      size: 28,
      stroke: 2,
    }),
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const rows = unresolved.map((name) => {
  const [candidate, reason] = proposed[name];
  if (!myoxusIcons[name]) throw new Error(`Missing Myoxus export ${name}`);
  if (!tablerIcons[candidate])
    throw new Error(`Missing Tabler export ${candidate}`);
  return {
    name,
    candidate,
    reason,
    usage: usageByName.get(name) ?? { references: 0, files: [] },
    myoxusMarkup: markup(myoxusIcons[name]),
    tablerMarkup: markup(tablerIcons[candidate]),
  };
});

function emptyReview() {
  return {
    schemaVersion: 1,
    iconSet: "tabler",
    batch: "open-problems",
    updatedAt: null,
    decisions: {},
  };
}

async function readReview() {
  try {
    return JSON.parse(await fs.readFile(decisionsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return emptyReview();
    throw error;
  }
}

async function writeReview(input) {
  const output = emptyReview();
  for (const row of rows) {
    const decision = input?.decisions?.[row.name];
    if (!decision || !statuses.has(decision.status)) continue;
    const tabler = String(decision.tabler || row.candidate)
      .trim()
      .slice(0, 120);
    output.decisions[row.name] = {
      status: decision.status,
      myoxus: row.name,
      tabler,
      note: String(decision.note ?? "")
        .trim()
        .slice(0, 2000),
    };
  }
  output.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(decisionsPath), { recursive: true });
  await fs.writeFile(
    `${decisionsPath}.tmp`,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  await fs.rename(`${decisionsPath}.tmp`, decisionsPath);
  return output;
}

function page(review) {
  const decisionJson = JSON.stringify(review.decisions).replace(
    /</g,
    "\\u003c",
  );
  const options = [
    ["", "Noch offen"],
    ["accept", "Kandidat passt"],
    ["change", "Anderes Tabler-Icon"],
    ["keep", "Myoxus behalten"],
    ["custom", "Custom nötig"],
    ["remove", "Export entfernen"],
  ];
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Offene Tabler-Glyphen</title>
<style>
  :root { color-scheme: light; --bg:#f4f5f7; --panel:#fff; --ink:#17181b; --muted:#686c75; --line:#d9dce2; --accent:#5a55d6; }
  * { box-sizing:border-box; } body { margin:0; min-width:1180px; background:var(--bg); color:var(--ink); font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif; }
  main { width:1460px; margin:0 auto; padding:26px 30px 80px; }
  h1 { margin:0 0 5px; font-size:25px; } .intro { margin:0; color:var(--muted); max-width:980px; }
  .summary { position:sticky; top:0; z-index:4; display:flex; align-items:center; justify-content:space-between; margin:20px 0 12px; padding:12px 15px; border:1px solid var(--line); border-radius:12px; background:rgba(255,255,255,.96); box-shadow:0 6px 22px rgba(25,28,35,.08); }
  .counts { display:flex; gap:22px; } .counts span { color:var(--muted); } .counts strong { color:var(--ink); font-size:17px; } #save { color:var(--muted); }
  table { width:100%; border-collapse:separate; border-spacing:0; background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th { padding:10px 12px; text-align:left; background:#f0f1f4; color:#555a64; font-size:12px; border-bottom:1px solid var(--line); }
  td { padding:12px; vertical-align:top; border-bottom:1px solid #e8e9ed; } tr:last-child td { border-bottom:0; }
  tr[data-status="accept"] td:last-child { box-shadow:inset -4px 0 #2f9e68; } tr[data-status="change"] td:last-child { box-shadow:inset -4px 0 #f59f00; } tr[data-status="keep"] td:last-child { box-shadow:inset -4px 0 #5a55d6; } tr[data-status="custom"] td:last-child { box-shadow:inset -4px 0 #d9485f; } tr[data-status="remove"] td:last-child { box-shadow:inset -4px 0 #343a40; }
  .name { display:block; font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; } .usage { margin-top:5px; color:var(--muted); font-size:12px; }
  .reason { width:290px; color:#454954; } .sample { width:180px; text-align:center; } .stage { height:50px; display:grid; place-items:center; border:1px solid var(--line); border-radius:9px; background:#fafafa; color:#1c1d20; } .stage svg { display:block; }
  code { display:block; margin-top:6px; color:#5d616a; font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
  .review { width:330px; display:grid; gap:7px; } select,input { width:100%; border:1px solid var(--line); border-radius:8px; padding:8px 9px; background:#fff; color:var(--ink); font:12px/1.3 inherit; } input[data-kind="tabler"] { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; } select:focus,input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  details { margin-top:6px; color:var(--muted); font-size:11px; } details ul { margin:5px 0 0; padding-left:17px; } details code { display:inline; }
</style></head><body><main>
  <h1>Nur noch offene oder riskante Glyphen</h1>
  <p class="intro">51 Entscheidungen wurden bereits übernommen. Hier stehen ausschließlich die ${rows.length} versehentlich offengebliebenen Restfälle. Desktop-interne Prüfseite.</p>
  <div class="summary"><div class="counts"><span><strong>${rows.length}</strong> zu prüfen</span><span><strong id="done">0</strong> bewertet</span><span><strong id="open">${rows.length}</strong> offen</span></div><span id="save">Bereit</span></div>
  <table><thead><tr><th>Myoxus-Export</th><th>Warum offen?</th><th>Bestand</th><th>nächster Tabler-Kandidat</th><th>Entscheidung</th></tr></thead><tbody>
  ${rows
    .map((row) => {
      const decision = review.decisions[row.name] ?? {};
      const sources = row.usage.files ?? [];
      return `<tr data-name="${row.name}" data-status="${escapeHtml(decision.status ?? "")}">
      <td><span class="name">${row.name}</span><div class="usage">${row.usage.references} aktive Referenzen</div>${
        sources.length
          ? `<details><summary>${sources.length} Quelldateien</summary><ul>${sources
              .slice(0, 5)
              .map((file) => `<li><code>${escapeHtml(file.path)}</code></li>`)
              .join("")}</ul></details>`
          : ""
      }</td>
      <td class="reason">${escapeHtml(row.reason)}</td>
      <td class="sample"><div class="stage">${row.myoxusMarkup}</div><code>${row.name}</code></td>
      <td class="sample"><div class="stage candidate-stage">${row.tablerMarkup}</div><code class="candidate-label">${row.candidate}</code></td>
      <td><div class="review"><select>${options.map(([value, label]) => `<option value="${value}" ${decision.status === value ? "selected" : ""}>${label}</option>`).join("")}</select><input data-kind="tabler" value="${escapeHtml(decision.tabler ?? row.candidate)}" aria-label="Tabler-Komponente"><input data-kind="note" value="${escapeHtml(decision.note ?? "")}" placeholder="Optional: kurzer Hinweis"></div></td>
    </tr>`;
    })
    .join("")}
  </tbody></table>
</main><script>
  const decisions = ${decisionJson}; let timer;
  const rows = [...document.querySelectorAll('tbody tr')];
  function counts() { const done=rows.filter(r=>r.querySelector('select').value).length; document.querySelector('#done').textContent=done; document.querySelector('#open').textContent=rows.length-done; }
  async function save() { document.querySelector('#save').textContent='Speichert …'; await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decisions})}); document.querySelector('#save').textContent='Gespeichert'; }
  function queueSave() { clearTimeout(timer); timer=setTimeout(save,250); }
  async function preview(row,name) { const response=await fetch('/api/tabler?name='+encodeURIComponent(name)); if(!response.ok) { row.querySelector('.candidate-stage').textContent='?'; return; } const data=await response.json(); row.querySelector('.candidate-stage').innerHTML=data.markup; row.querySelector('.candidate-label').textContent=name; }
  for (const row of rows) { const name=row.dataset.name, select=row.querySelector('select'), tabler=row.querySelector('[data-kind="tabler"]'), note=row.querySelector('[data-kind="note"]');
    const sync=()=>{ if(select.value) decisions[name]={status:select.value,tabler:tabler.value.trim(),note:note.value}; else delete decisions[name]; row.dataset.status=select.value; counts(); queueSave(); };
    select.addEventListener('change',sync); note.addEventListener('input',sync); tabler.addEventListener('change',()=>{preview(row,tabler.value.trim());sync();});
  } counts();
</script></body></html>`;
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(page(await readReview()));
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tabler") {
      const name = url.searchParams.get("name") ?? "";
      const Component = tablerIcons[name];
      if (!Component) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ markup: markup(Component) }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/review") {
      const review = await writeReview(await bodyJson(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(review));
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error?.stack ?? error));
  }
});

server.listen(port, host, () =>
  console.log(
    `Open Tabler review: http://${host}:${port}/ (${rows.length} glyphs)`,
  ),
);
