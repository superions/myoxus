import { DocTitle } from "./doc-title";

export * from "./doc-title";

export function effects() {
  customElements.define("myoxus-linked-doc-title", DocTitle);
}
