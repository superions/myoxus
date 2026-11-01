// SPDX-License-Identifier: AGPL-3.0-or-later
import DOMPurify from "dompurify";

/** Shared structured boundary for internal renderer and untrusted stored output.
 * Sanitization is not an execution-validity claim for the source BPMN model. */
function sanitizedSvg(source: string) {
  if (!DOMPurify.isSupported) throw new Error("BPMN_RENDER_FAILED");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
    throw new Error("BPMN_RENDER_FAILED");
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (
    document.documentElement.namespaceURI !== "http://www.w3.org/2000/svg" ||
    document.documentElement.localName !== "svg" ||
    document.querySelector("parsererror")
  )
    throw new Error("BPMN_RENDER_FAILED");
  // Same structured-XML/DOMPurify practice as the Edgeless clipboard owner, with
  // the smaller attribute/tag surface actually emitted by this BPMN renderer.
  // No HTML, scripts, animation, images, links or externally referenced symbols.
  const sanitized = DOMPurify.sanitize(document.documentElement, {
    ALLOWED_TAGS: [
      "svg",
      "g",
      "defs",
      "marker",
      "path",
      "circle",
      "ellipse",
      "rect",
      "line",
      "polyline",
      "polygon",
      "text",
      "tspan",
      "clippath",
    ],
    ALLOWED_ATTR: [
      "xmlns",
      "id",
      "width",
      "height",
      "viewBox",
      "style",
      "x",
      "y",
      "x1",
      "y1",
      "x2",
      "y2",
      "cx",
      "cy",
      "r",
      "rx",
      "ry",
      "d",
      "points",
      "transform",
      "fill",
      "fill-rule",
      "fill-opacity",
      "stroke",
      "stroke-width",
      "stroke-dasharray",
      "stroke-linejoin",
      "stroke-linecap",
      "stroke-opacity",
      "opacity",
      "text-anchor",
      "dominant-baseline",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "text-decoration",
      "refX",
      "refY",
      "markerUnits",
      "markerWidth",
      "markerHeight",
      "orient",
      "marker-start",
      "marker-mid",
      "marker-end",
      "clip-path",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_ATTR: [
      "data-bpmn-element-id",
      "data-bpmn-source-revision",
      "data-bpmn-preview-background",
    ],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = sanitized.firstElementChild;
  if (
    !(svg instanceof SVGElement) ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg" ||
    svg.localName !== "svg"
  )
    throw new Error("BPMN_RENDER_FAILED");
  // The retained renderer uses local marker URLs. Do not turn a future renderer
  // addition into a network-bearing downloadable asset; page-frozen theme styles
  // may remain, but CSS resource URLs are not part of this output contract.
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    const resources = [...element.attributes].filter(
      (attribute) =>
        /url\s*\(/i.test(attribute.value) &&
        (attribute.name === "style" ||
          !/^url\(\s*#[a-zA-Z0-9_-]+\s*\)$/.test(attribute.value)),
    );
    for (const attribute of resources) element.removeAttributeNode(attribute);
  }
  return svg;
}

export function sanitizeBpmnSvg(source: string, revision: string): string {
  return prepareBpmnPreviewSvg(source, revision);
}

/** Persisted/remote previews are untrusted too. Reuse the renderer allowlist,
 * discard page-frozen custom properties and restrict CSS to notation geometry
 * and font presentation. Paint and label typography become current theme roles,
 * not the producer's resolved CSS. Stored previews are derived notation, never a
 * second authoring source for imported BPMNDI font metadata;
 * escaped resource functions cannot survive this positive value projection.
 * Materialize these variables/fonts into an isolated image only after this step.
 * expectedSourceRevision requires the stored provenance marker; producers may
 * rebind a verified fork candidate to its durable head, passive views may not. */
export function prepareBpmnPreviewSvg(
  source: string,
  revision: string,
  expectedSourceRevision?: string,
): string {
  const svg = sanitizedSvg(source);
  if (
    expectedSourceRevision !== undefined &&
    svg.getAttribute("data-bpmn-source-revision") !== expectedSourceRevision
  )
    throw new Error("BPMN_STALE_SNAPSHOT");
  const ids = new Set(
    [svg, ...svg.querySelectorAll("[id]")].map((element) =>
      element.getAttribute("id"),
    ),
  );
  const numberList =
    /^[+\-\d.]+(?:px|pt|em|rem|%)?(?:[ ,]+[+\-\d.]+(?:px|pt|em|rem|%)?)*$/;
  const paint = (value: string) =>
    /^(?:none|transparent)$/i.test(value.trim())
      ? "none"
      : value.trim() === "var(--mantine-color-body)"
        ? "var(--mantine-color-body)"
        : value.trim() === "var(--mantine-color-error)"
          ? "var(--mantine-color-error)"
          : "var(--mantine-color-text)";
  const presentation = (
    property: string,
    value: string,
  ): string | undefined => {
    if (["fill", "stroke", "color"].includes(property)) return paint(value);
    // Renderer snapshots may already contain resolved values. Rebind these at
    // every materialization so a cold passive image follows server typography
    // without regenerating the canonical source or opening a hidden modeller.
    if (property === "font-family") return "var(--mantine-font-family)";
    if (property === "font-size") return "var(--mantine-font-size-md)";
    if (property === "line-height") return "var(--mantine-line-height)";
    if (
      [
        "stroke-width",
        "stroke-dasharray",
        "opacity",
        "fill-opacity",
        "stroke-opacity",
      ].includes(property)
    )
      return numberList.test(value) ? value : undefined;
    const values: Record<string, readonly string[]> = {
      "font-weight": [
        "normal",
        "bold",
        "100",
        "200",
        "300",
        "400",
        "500",
        "600",
        "700",
        "800",
        "900",
      ],
      "font-style": ["normal", "italic", "oblique"],
      "text-decoration": [
        "none",
        "underline",
        "line-through",
        "underline line-through",
      ],
      "paint-order": ["normal", "stroke fill", "fill stroke"],
      "stroke-linejoin": ["miter", "round", "bevel"],
      "stroke-linecap": ["butt", "round", "square"],
      "white-space": ["normal", "pre", "pre-wrap"],
      "text-anchor": ["start", "middle", "end"],
    };
    return values[property]?.includes(value) ? value : undefined;
  };
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if (!(element instanceof SVGElement)) {
      element.remove();
      continue;
    }
    const styles = Array.from(element.style).map(
      (property) =>
        [property, element.style.getPropertyValue(property).trim()] as const,
    );
    element.removeAttribute("style");
    for (const [property, value] of styles) {
      const safe = presentation(property, value);
      if (safe !== undefined) element.style.setProperty(property, safe);
    }
    for (const property of [
      "fill",
      "stroke",
      "color",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "text-decoration",
    ]) {
      const value = element.getAttribute(property);
      if (value === null) continue;
      const safe = presentation(property, value);
      if (safe === undefined) element.removeAttribute(property);
      else element.setAttribute(property, safe);
    }
    for (const property of [
      "marker-start",
      "marker-mid",
      "marker-end",
      "clip-path",
    ]) {
      const value = element.getAttribute(property);
      if (value === null) continue;
      const fragment = /^url\(\s*#([a-zA-Z0-9_.:-]+)\s*\)$/.exec(value)?.[1];
      if (!fragment || !ids.has(fragment)) element.removeAttribute(property);
    }
  }
  svg.setAttribute("data-bpmn-source-revision", revision);
  const viewBox = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[ ,]+/)
    .map(Number);
  if (
    !viewBox ||
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2]! <= 0 ||
    viewBox[3]! <= 0
  )
    throw new Error("BPMN_RENDER_FAILED");
  // An isolated image may sit on an authored note of the opposite color. Its
  // labels/masks need their own semantic surface, not a transparent backdrop.
  for (const old of svg.querySelectorAll("[data-bpmn-preview-background]"))
    old.remove();
  const background = svg.ownerDocument.createElementNS(
    "http://www.w3.org/2000/svg",
    "rect",
  );
  for (const [index, attribute] of ["x", "y", "width", "height"].entries())
    background.setAttribute(attribute, String(viewBox[index]));
  background.setAttribute("fill", "var(--mantine-color-body)");
  background.setAttribute("stroke", "none");
  background.setAttribute("data-bpmn-preview-background", "true");
  svg.prepend(background);
  svg.style.setProperty("color", "var(--mantine-color-text)");
  if (!svg.hasAttribute("fill") && !svg.style.getPropertyValue("fill"))
    svg.style.setProperty("fill", "var(--mantine-color-text)");
  svg.style.setProperty("font-family", "var(--mantine-font-family)");
  return new XMLSerializer().serializeToString(svg);
}
