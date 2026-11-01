import { MYOXUS_OUTLINE_NOTICE, OutlineNotice } from "./body/outline-notice";
import {
  MYOXUS_OUTLINE_PANEL_BODY,
  OutlinePanelBody,
} from "./body/outline-panel-body";
import { MYOXUS_OUTLINE_NOTE_CARD, OutlineNoteCard } from "./card/outline-card";
import {
  MYOXUS_OUTLINE_BLOCK_PREVIEW,
  OutlineBlockPreview,
} from "./card/outline-preview";
import {
  MYOXUS_OUTLINE_PANEL_HEADER,
  OutlinePanelHeader,
} from "./header/outline-panel-header";
import {
  MYOXUS_OUTLINE_NOTE_PREVIEW_SETTING_MENU,
  OutlineNotePreviewSettingMenu,
} from "./header/outline-setting-menu";
import {
  MobileOutlineMenu,
  MYOXUS_MOBILE_OUTLINE_MENU,
} from "./mobile-outline-panel";
import { MYOXUS_OUTLINE_PANEL, OutlinePanel } from "./outline-panel";
import { MYOXUS_OUTLINE_VIEWER, OutlineViewer } from "./outline-viewer";

export function effects() {
  customElements.define(
    MYOXUS_OUTLINE_NOTE_PREVIEW_SETTING_MENU,
    OutlineNotePreviewSettingMenu,
  );
  customElements.define(MYOXUS_OUTLINE_NOTICE, OutlineNotice);
  customElements.define(MYOXUS_OUTLINE_PANEL, OutlinePanel);
  customElements.define(MYOXUS_OUTLINE_PANEL_HEADER, OutlinePanelHeader);
  customElements.define(MYOXUS_OUTLINE_NOTE_CARD, OutlineNoteCard);
  customElements.define(MYOXUS_OUTLINE_VIEWER, OutlineViewer);
  customElements.define(MYOXUS_MOBILE_OUTLINE_MENU, MobileOutlineMenu);
  customElements.define(MYOXUS_OUTLINE_BLOCK_PREVIEW, OutlineBlockPreview);
  customElements.define(MYOXUS_OUTLINE_PANEL_BODY, OutlinePanelBody);
}
