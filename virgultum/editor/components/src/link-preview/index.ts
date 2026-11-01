import { LinkPreview } from "./link";

export * from "./link";

export function effects() {
  customElements.define("myoxus-link-preview", LinkPreview);
}
