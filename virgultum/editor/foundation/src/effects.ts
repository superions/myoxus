import { BlockSelection } from "@virgultum/components/block-selection";
import { BlockZeroWidth } from "@virgultum/components/block-zero-width";
import { effects as componentCaptionEffects } from "@virgultum/components/caption";
import { effects as componentCitationEffects } from "@virgultum/components/citation";
import { effects as componentColorPickerEffects } from "@virgultum/components/color-picker";
import { effects as componentContextMenuEffects } from "@virgultum/components/context-menu";
import { effects as componentDatePickerEffects } from "@virgultum/components/date-picker";
import { effects as componentDropIndicatorEffects } from "@virgultum/components/drop-indicator";
import { effects as componentEdgelessLineWidthEffects } from "@virgultum/components/edgeless-line-width-panel";
import { effects as componentHighlightDropdownMenuEffects } from "@virgultum/components/highlight-dropdown-menu";
import { IconButton } from "@virgultum/components/icon-button";
import { effects as componentLinkPreviewEffects } from "@virgultum/components/link-preview";
import { effects as componentLinkedDocTitleEffects } from "@virgultum/components/linked-doc-title";
import { effects as componentPortalEffects } from "@virgultum/components/portal";
import { effects as componentResourceEffects } from "@virgultum/components/resource";
import { effects as componentSliderEffects } from "@virgultum/components/slider";
import { SmoothCorner } from "@virgultum/components/smooth-corner";
import { effects as componentToggleButtonEffects } from "@virgultum/components/toggle-button";
import { ToggleSwitch } from "@virgultum/components/toggle-switch";
import { effects as componentToolbarEffects } from "@virgultum/components/toolbar";
import { effects as componentTooltipContentWithShortcutEffects } from "@virgultum/components/tooltip-content-with-shortcut";
import { effects as richTextEffects } from "@virgultum/rich-text/effects";
import { effects as stdEffects } from "@virgultum/std/effects";

export function effects() {
  stdEffects();

  richTextEffects();

  componentCaptionEffects();
  componentContextMenuEffects();
  componentDatePickerEffects();
  componentPortalEffects();
  componentToolbarEffects();
  componentDropIndicatorEffects();
  componentToggleButtonEffects();
  componentColorPickerEffects();
  componentLinkPreviewEffects();
  componentLinkedDocTitleEffects();
  componentCitationEffects();
  componentHighlightDropdownMenuEffects();
  componentTooltipContentWithShortcutEffects();
  componentSliderEffects();
  componentEdgelessLineWidthEffects();
  componentResourceEffects();

  customElements.define("icon-button", IconButton);
  customElements.define("smooth-corner", SmoothCorner);
  customElements.define("toggle-switch", ToggleSwitch);
  customElements.define("block-zero-width", BlockZeroWidth);
  customElements.define("myoxus-block-selection", BlockSelection);
}
