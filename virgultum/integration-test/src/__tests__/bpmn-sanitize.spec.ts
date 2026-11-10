// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { prepareBpmnPreviewSvg } from "@myoxus/bpmn-editor/preview";

test("stored SVG strips active resources but retains local notation, typography and semantic paint", () => {
  const output = prepareBpmnPreviewSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100" onload="alert(1)" style="--poison:url(https://host.invalid);background-image:u\\72l(https://host.invalid)">
    <script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>
    <image href="https://host.invalid/a.svg"/><use href="https://host.invalid/a.svg#x"/><style>@import 'https://host.invalid/x.css';</style>
    <defs><marker id="arrow"><path d="M0 0L4 2L0 4Z" fill="var(--mantine-color-text)"/></marker></defs>
    <path id="flow" d="M0 0L40 40" marker-end="url(#arrow)" marker-start="url(https://host.invalid/a.svg#x)" style="stroke:var(--mantine-color-text);fill:none;filter:u\\72l(https://host.invalid/a)"/>
    <rect width="100" height="60" fill="var(--mantine-color-body)" stroke="var(--mantine-color-text)"/>
    <text x="10" y="20" font-size="16" style="font-family:Inter;font-weight:bold;paint-order:stroke;stroke:var(--mantine-color-body)" onclick="alert(1)">Approve</text>
  </svg>`,
    "selected-head",
  );
  const svg = new DOMParser().parseFromString(
    output,
    "image/svg+xml",
  ).documentElement;
  expect(svg.getAttribute("data-bpmn-source-revision")).toBe("selected-head");
  expect(svg.querySelector("script,foreignObject,image,use,style")).toBeNull();
  expect(output).not.toMatch(
    /host\.invalid|onload|onclick|background(?:-image)?\s*:|filter\s*:|--poison/,
  );
  expect(svg.querySelector("#flow")?.getAttribute("marker-end")).toBe(
    "url(#arrow)",
  );
  expect(svg.querySelector("#flow")?.hasAttribute("marker-start")).toBe(false);
  expect(svg.querySelector("rect")?.getAttribute("fill")).toBe(
    "var(--mantine-color-body)",
  );
  const reprojected = new DOMParser().parseFromString(
    prepareBpmnPreviewSvg(output, "selected-head", "selected-head"),
    "image/svg+xml",
  );
  expect(
    reprojected.querySelectorAll("[data-bpmn-preview-background]"),
  ).toHaveLength(1);
  expect(svg.querySelector("text")?.textContent).toBe("Approve");
  expect(svg.querySelector("text")?.getAttribute("font-size")).toBe(
    "var(--mantine-font-size-md)",
  );
  expect(svg.querySelector("text")?.getAttribute("style")).toContain(
    "font-family: var(--mantine-font-family)",
  );
  expect(svg.querySelector("text")?.style.paintOrder).toBe("stroke");
  expect(() =>
    prepareBpmnPreviewSvg(output, "new-head", "different-head"),
  ).toThrow("BPMN_STALE_SNAPSHOT");
  expect(() =>
    prepareBpmnPreviewSvg(
      '<!DOCTYPE svg [<!ENTITY x "text">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      "head",
    ),
  ).toThrow("BPMN_RENDER_FAILED");
});
