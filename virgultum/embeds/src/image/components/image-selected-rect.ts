export const imageSelectedRectStyles = `
  .myoxus-page-selected-embed-rects-container {
    position: absolute;
    border: 2px solid var(--myoxus-primary-color);
    left: 0;
    top: 0;
    width: 100%;
    height: calc(100% + 1px);
    user-select: none;
    pointer-events: none;
    box-sizing: border-box;
    line-height: 0;
  }

  .myoxus-page-selected-embed-rects-container .resize {
    position: absolute;
    padding: 5px;
    pointer-events: auto;
    z-index: 1;
  }

  .myoxus-page-selected-embed-rects-container .resize-inner {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--myoxus-background-primary-color);
    border: 2px solid var(--myoxus-primary-color);
    pointer-events: none;
  }

  .myoxus-page-selected-embed-rects-container .resize.top-left {
    left: 0;
    top: 0;
    transform: translate(-50%, -50%);
    cursor: nwse-resize; /*resizer cursor*/
  }
  .myoxus-page-selected-embed-rects-container .resize.top-right {
    right: 0;
    top: 0;
    transform: translate(50%, -50%);
    cursor: nesw-resize;
  }
  .myoxus-page-selected-embed-rects-container .resize.bottom-left {
    left: 0;
    bottom: 0;
    transform: translate(-50%, 50%);
    cursor: nesw-resize;
  }
  .myoxus-page-selected-embed-rects-container .resize.bottom-right {
    right: 0;
    bottom: 0;
    transform: translate(50%, 50%);
    cursor: nwse-resize;
  }

  @keyframes myoxus-image-spinner-rotate {
    100% {
      transform: rotate(360deg);
    }
  }

  .myoxus-image-loading-spinner {
    transform-origin: center;
    animation: myoxus-image-spinner-rotate 0.75s infinite linear;
  }
`;

const RESIZE_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export function createImageSelectedRect(doc: Document, readonly: boolean) {
  const container = doc.createElement("div");
  container.className =
    "myoxus-page-selected-embed-rects-container resizable resizes";
  if (!readonly) {
    for (const corner of RESIZE_CORNERS) {
      const handle = doc.createElement("div");
      handle.className = `resize ${corner}`;
      const inner = doc.createElement("div");
      inner.className = "resize-inner";
      handle.append(inner);
      container.append(handle);
    }
  }
  return container;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function createImageLoadingSpinner(
  doc: Document,
  {
    size = "1em",
    progress = 0.2,
    ringColor = "var(--myoxus-white-60)",
    strokeColor = "var(--myoxus-pure-white)",
  }: {
    size?: string;
    progress?: number;
    ringColor?: string;
    strokeColor?: string;
  } = {},
) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.style.fill = "none";

  const ring = doc.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", "12");
  ring.setAttribute("cy", "12");
  ring.setAttribute("r", "8");
  ring.setAttribute("stroke", ringColor);
  ring.setAttribute("stroke-width", "4");

  const spinner = doc.createElementNS(SVG_NS, "circle");
  spinner.setAttribute("class", "myoxus-image-loading-spinner");
  spinner.setAttribute("cx", "12");
  spinner.setAttribute("cy", "12");
  spinner.setAttribute("r", "8");
  spinner.setAttribute("stroke", strokeColor);
  spinner.setAttribute("stroke-width", "4");
  spinner.setAttribute("stroke-linecap", "round");
  spinner.setAttribute(
    "stroke-dasharray",
    `${2 * Math.PI * 8 * progress} ${2 * Math.PI * 8 * (1 - progress)}`,
  );

  svg.append(ring, spinner);
  return svg;
}
