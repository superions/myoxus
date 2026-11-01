export function linkIframe(iframe: HTMLIFrameElement, html: string) {
  // A srcdoc frame without allow-same-origin receives an opaque origin. Keep
  // that isolation even if a caller reuses an iframe configured elsewhere.
  iframe.sandbox.remove("allow-same-origin");
  iframe.sandbox.add(
    "allow-pointer-lock",
    "allow-popups",
    "allow-forms",
    "allow-popups-to-escape-sandbox",
    "allow-downloads",
    "allow-scripts",
  );
  iframe.removeAttribute("src");
  iframe.srcdoc = html;
}
