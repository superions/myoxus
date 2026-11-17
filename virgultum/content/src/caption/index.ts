import { BlockCaptionEditor } from "./caption-session.js";
export { BlockCaptionEditor } from "./caption-session.js";
export {
  CaptionedBlockComponent,
  SelectedStyle,
} from "./captioned-block-component.js";

export function effects() {
  customElements.define("block-caption-editor", BlockCaptionEditor);
}
