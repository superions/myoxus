import { type effects as blockRootEffects } from "./blocks/root/effects";
import { type effects as componentCaptionEffects } from "@virgultum/content/caption";
import { type effects as componentDropIndicatorEffects } from "@virgultum/core/view/drop-indicator";
import { type effects as componentLinkPreviewEffects } from "@virgultum/content/link-preview";
import { type effects as componentLinkedDocTitleEffects } from "@virgultum/content/linked-doc-title";
import { type effects as componentToggleButtonEffects } from "@virgultum/content/disclosure";
import { type RichTextEffects as richTextEffects } from "@virgultum/content/effects";
import { type effects as stdEffects } from "@virgultum/core/runtime/effects";

export declare const _GLOBAL_:
  | typeof stdEffects
  | typeof richTextEffects
  | typeof blockRootEffects
  | typeof componentCaptionEffects
  | typeof componentDropIndicatorEffects
  | typeof componentLinkPreviewEffects
  | typeof componentLinkedDocTitleEffects
  | typeof componentToggleButtonEffects;
