import { BlockSelection } from "@virgultum/core/view/block-selection";
import { BlockZeroWidth } from "@virgultum/core/view/block-zero-width";
import { effects as componentCaptionEffects } from "@virgultum/content/caption";
import { effects as componentDropIndicatorEffects } from "@virgultum/core/view/drop-indicator";
import { effects as componentLinkPreviewEffects } from "@virgultum/content/link-preview";
import { effects as componentLinkedDocTitleEffects } from "@virgultum/content/linked-doc-title";
import { effects as componentToggleButtonEffects } from "@virgultum/content/disclosure";
import { RichTextEffects as richTextEffects } from "@virgultum/content/effects";
import { effects as stdEffects } from "@virgultum/core/runtime/effects";

export function effects() {
  stdEffects();

  richTextEffects();

  componentCaptionEffects();
  componentDropIndicatorEffects();
  componentToggleButtonEffects();
  componentLinkPreviewEffects();
  componentLinkedDocTitleEffects();

  customElements.define("block-zero-width", BlockZeroWidth);
  customElements.define("myoxus-block-selection", BlockSelection);
}
