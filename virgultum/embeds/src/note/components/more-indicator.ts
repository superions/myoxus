const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createMoreIndicator(document: Document) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("width", "34");
  svg.setAttribute("height", "29");
  svg.setAttribute("viewBox", "0 0 34 29");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute(
    "d",
    "M3 14.4292L16.8345 18.9019C17.0345 18.9665 17.2498 18.9665 17.4498 18.9019L31.2843 14.4292",
  );
  path.setAttribute("stroke", "black");
  path.setAttribute("stroke-opacity", "0.3");
  path.setAttribute("stroke-width", "5");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}
