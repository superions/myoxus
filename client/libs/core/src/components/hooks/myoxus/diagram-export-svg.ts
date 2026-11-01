// SPDX-License-Identifier: AGPL-3.0-or-later

function fontFaces(rules: CSSRuleList): CSSFontFaceRule[] {
  return Array.from(rules).flatMap((rule) => {
    if (rule.type === CSSRule.FONT_FACE_RULE) return [rule as CSSFontFaceRule];
    return "cssRules" in rule
      ? fontFaces((rule as CSSGroupingRule).cssRules)
      : [];
  });
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** SVG images have an isolated font/style environment. Materialize the current
 * native output and its registered font assets before download or rasterizing;
 * document Source and native geometry remain untouched. A canceled passive
 * materialization removes its measurement mount and aborts font fetches.
 * projectionRoot supplies the embedding provider's roles (a dark note may live
 * inside a light application), never presentation supplied by stored markup. */
export async function materializeDiagramExportSvg(
  svg: string,
  signal?: AbortSignal,
  projectionRoot?: Element,
): Promise<string> {
  signal?.throwIfAborted();
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (
    parsed.querySelector("parsererror") ||
    parsed.documentElement.localName !== "svg"
  )
    throw new Error("Invalid diagram SVG export.");
  const root = document.importNode(
    parsed.documentElement,
    true,
  ) as unknown as SVGSVGElement;
  if (projectionRoot) {
    const projection = getComputedStyle(projectionRoot);
    for (const property of Array.from(projection)) {
      if (property.startsWith("--mantine-"))
        root.style.setProperty(property, projection.getPropertyValue(property));
    }
  }
  const mount = document.createElement("div");
  mount.style.position = "absolute";
  mount.style.visibility = "hidden";
  mount.append(root);
  document.body.append(mount);
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    mount.remove();
    aborted.reject(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([document.fonts.ready, aborted.promise]);
    signal?.throwIfAborted();
    const families = new Set<string>();
    const projected = [root, ...root.querySelectorAll<SVGElement>("*")].map(
      (element) => {
        const style = getComputedStyle(element);
        const values = Object.fromEntries(
          [
            "font-family",
            "font-size",
            "font-style",
            "font-weight",
            "fill",
            "stroke",
            "color",
          ].map((property) => [property, style.getPropertyValue(property)]),
        );
        for (const family of values["font-family"]!.split(","))
          families.add(
            family
              .trim()
              .replace(/^['"]|['"]$/g, "")
              .toLowerCase(),
          );
        return { element, values };
      },
    );
    for (const { element, values } of projected)
      for (const [property, value] of Object.entries(values))
        if (value && !value.includes("url("))
          element.style.setProperty(property, value);
    const faces = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return fontFaces(sheet.cssRules);
        } catch (error) {
          if (error instanceof DOMException && error.name === "SecurityError")
            return [];
          throw error;
        }
      })
      .filter((face) =>
        families.has(
          face.style.fontFamily.replace(/^['"]|['"]$/g, "").toLowerCase(),
        ),
      );
    const uniqueFaces = [
      ...new Map(faces.map((face) => [face.style.cssText, face])).values(),
    ];
    const fonts = new Map<string, Promise<string>>();
    const embedded = await Promise.all(
      uniqueFaces.map(async (face) => {
        const src = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(
          face.style.getPropertyValue("src"),
        );
        if (!src) return "";
        const url = new URL(src[1]!, document.baseURI).href;
        let pending = fonts.get(url);
        if (!pending) {
          pending = fetch(url, { signal }).then(async (response) => {
            if (!response.ok)
              throw new Error("Diagram export font could not be loaded.");
            return dataUrl(await response.blob());
          });
          fonts.set(url, pending);
        }
        const style = face.style.cssText.replace(
          /src\s*:[^;]+;?/i,
          `src: url("${await pending}");`,
        );
        return `@font-face { ${style} }`;
      }),
    );
    signal?.throwIfAborted();
    const style = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "style",
    );
    style.textContent = embedded.join("\n");
    // Embedded faces belong to the standalone image, not the live document's
    // FontFaceSet or its font-readiness/renderer lifecycle.
    mount.remove();
    root.prepend(style);
    return new XMLSerializer().serializeToString(root);
  } finally {
    signal?.removeEventListener("abort", abort);
    mount.remove();
  }
}
