// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const guard = fileURLToPath(
  new URL("./verify-no-direct-product-svg.mjs", import.meta.url),
);
const fixtures = new Map([
  [
    "client/libs/core/src/desktop/pages/workspace/diagrams/diagram-preview.tsx",
    '<svg viewBox="0 0 120 82">',
  ],
  [
    "client/libs/ui-facade/src/data-views/charts/sankey-chart.tsx",
    "<svg viewBox={`0 0 ${layoutWidth} ${geometry.height}`}>",
  ],
  [
    "client/libs/ui-facade/src/data-views/charts/treemap-chart.tsx",
    "<svg viewBox={`0 0 ${width} ${height}`}>",
  ],
  [
    "client/libs/ui-facade/src/data-views/gantt/gantt-dependencies.tsx",
    '<svg data-myoxus-ui-role="gantt-dependencies">\n<svg data-myoxus-ui-role="gantt-dependency-handles">',
  ],
  [
    "client/libs/ui-facade/src/data-views/gantt/gantt-task.tsx",
    '<svg className="myoxus-gantt-range-shape">',
  ],
  [
    "client/libs/ui-facade/src/data-views/temporal/temporal.tsx",
    '<svg data-myoxus-ui-role="temporal-dependencies">',
  ],
  [
    "client/libs/ui-facade/src/data-views/charts/charts.css",
    '.myoxus-data-sankey-chart-surface svg {\n.myoxus-data-sankey-chart-surface svg:not([data-use-max-width="true"]) {\n.myoxus-data-treemap-chart-surface svg {\nsvg[data-reparent-target-id]\n.myoxus-data-radar-chart-surface svg {',
  ],
  [
    "client/libs/ui-facade/src/page-detail-loading.tsx",
    'import dark from "./assets/page-detail-loading.dark.svg";\nimport light from "./assets/page-detail-loading.light.svg";',
  ],
  [
    "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/journal/assets.ts",
    "<svg>journal artwork</svg>",
  ],
]);

function check(files) {
  const root = mkdtempSync(path.join(tmpdir(), "myoxus-svg-guard-"));
  try {
    for (const [file, source] of files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const result = spawnSync(process.execPath, [guard, "--check"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("owned artwork and exact renderer geometry are admitted", () => {
  const result = check(fixtures);
  assert.equal(result.status, 0, result.output);
});

test("renderer owners still reject new inline icons, SVG imports and chrome selectors", () => {
  const files = new Map(
    [...fixtures].filter(([file]) => !file.endsWith("journal/assets.ts")),
  );
  for (const [file, source] of files) {
    files.set(
      file,
      source +
        (file.endsWith(".css")
          ? "\n.toolbar svg { color: inherit; }"
          : '\n<svg aria-label="New icon">\nimport icon from "./new-icon.svg";'),
    );
  }
  files.set(
    "client/libs/ui-facade/src/new-control.tsx",
    '<svg data-myoxus-ui-role="gantt-dependencies">',
  );
  const result = check(files);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /inline-svg/);
  assert.match(result.output, /svg-import/);
  assert.match(result.output, /css-svg-selector/);
  for (const file of files.keys())
    assert.ok(result.output.includes(file), file);
});
