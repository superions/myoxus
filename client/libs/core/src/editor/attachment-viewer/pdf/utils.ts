import type { PageSize } from "@myoxus/core/modules/pdf/renderer/types";

export function fitToPage(
  viewportInfo: PageSize,
  actualSize: PageSize,
  maxSize: PageSize,
  isThumbnail?: boolean,
) {
  const { width: vw, height: vh } = viewportInfo;
  const { width: w, height: h } = actualSize;
  const { width: mw, height: mh } = maxSize;
  if (
    ![vw, vh, w, h, mw, mh].every(Number.isFinite) ||
    vw <= 0 ||
    vh <= 0 ||
    w <= 0 ||
    h <= 0 ||
    mw <= 0 ||
    mh <= 0
  ) {
    return { width: 0, height: 0, aspectRatio: 1 };
  }

  let width = 0;
  let height = 0;
  if (h / w > vh / vw) {
    height = vh * (h / mh);
    width = (w / h) * height;
  } else {
    const t = isThumbnail ? Math.min(w / h, 1) : w / mw;
    width = vw * t;
    height = (h / w) * width;
  }
  return {
    width: Math.ceil(width),
    height: Math.ceil(height),
    aspectRatio: width / height,
  };
}
