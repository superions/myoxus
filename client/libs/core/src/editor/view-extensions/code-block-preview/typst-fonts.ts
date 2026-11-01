const SERVER_FONT_ENDPOINT = "/api/fonts/" as const;

export const TYPST_PREVIEW_FONT_FILES = [
  "inter-vf.ttf",
  "inter-italic-vf.ttf",
  "source-sans-3-vf.ttf",
  "source-sans-3-italic-vf.ttf",
  "ibm-plex-mono-regular.ttf",
  "typst-DejaVuSansMono-Bold.ttf",
  "typst-DejaVuSansMono-BoldOblique.ttf",
  "typst-DejaVuSansMono-Oblique.ttf",
  "typst-DejaVuSansMono.ttf",
  "typst-LibertinusSerif-Bold.otf",
  "typst-LibertinusSerif-BoldItalic.otf",
  "typst-LibertinusSerif-Italic.otf",
  "typst-LibertinusSerif-Regular.otf",
  "typst-LibertinusSerif-Semibold.otf",
  "typst-LibertinusSerif-SemiboldItalic.otf",
  "typst-NewCM10-Bold.otf",
  "typst-NewCM10-BoldItalic.otf",
  "typst-NewCM10-Italic.otf",
  "typst-NewCM10-Regular.otf",
  "typst-NewCMMath-Bold.otf",
  "typst-NewCMMath-Book.otf",
  "typst-NewCMMath-Regular.otf",
] as const;

// Keep Typst preview fonts on the same server-owned font endpoint used by
// runtime theme CSS, Electron's font protocol handler and the PDF font catalog.
// The preview must not depend on a public CDN or a workspace-local route.
export const TYPST_FONT_URLS: readonly string[] = TYPST_PREVIEW_FONT_FILES.map(
  (file) => `${SERVER_FONT_ENDPOINT}${file}`,
);
