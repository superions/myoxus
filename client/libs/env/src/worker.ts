/**
 * @file worker.ts — @myoxus/env
 *
 * Helper for constructing versioned Web Worker URLs.
 *
 * Workers must obey the same-origin policy, so they cannot use
 * `publicPath` (which may be a CDN URL). Instead, the URL is built from
 * `environment.subPath` which is always same-origin.
 */

/**
 * Returns the versioned URL for a named Web Worker bundle.
 *
 * The URL format is `{subPath}/js/{name}-{appVersion}.worker.js`.
 *
 * @param name - Worker bundle name (e.g. `'storage'`).
 */
export function getWorkerUrl(name: string) {
  return (
    // NOTE: worker can not use publicPath because it must obey the same-origin policy
    (environment.subPath || "/") +
    "js/" +
    `${name}-${BUILD_CONFIG.appVersion}.worker.js`
  );
}

declare const __webpack_public_path__: string;

/** Local, version-matched resources emitted by the frontend bundler for PDF.js. */
export function getPdfResourceOptions(version: string) {
  const base = new URL(
    `${__webpack_public_path__}pdfjs/${version}/`,
    globalThis.location.href,
  ).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
    wasmUrl: `${base}wasm/`,
    // The embedded viewer runs inside a dedicated Worker without a Document.
    useWorkerFetch: true,
  };
}
