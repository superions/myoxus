import {
  FramePanelBody,
  MYOXUS_FRAME_PANEL_BODY,
} from "./body/frame-panel-body";
import { FrameCard, MYOXUS_FRAME_CARD } from "./card/frame-card";
import {
  FrameCardTitle,
  MYOXUS_FRAME_CARD_TITLE,
} from "./card/frame-card-title";
import {
  FrameCardTitleEditor,
  MYOXUS_FRAME_TITLE_EDITOR,
} from "./card/frame-card-title-editor";
import { FramePreview, MYOXUS_FRAME_PREVIEW } from "./card/frame-preview";
import { FramePanel, MYOXUS_FRAME_PANEL } from "./frame-panel";
import {
  FramePanelHeader,
  MYOXUS_FRAME_PANEL_HEADER,
} from "./header/frame-panel-header";
import {
  FramesSettingMenu,
  MYOXUS_FRAMES_SETTING_MENU,
} from "./header/frames-setting-menu";

export function effects() {
  customElements.define(MYOXUS_FRAME_PANEL, FramePanel);
  customElements.define(MYOXUS_FRAME_TITLE_EDITOR, FrameCardTitleEditor);
  customElements.define(MYOXUS_FRAME_CARD, FrameCard);
  customElements.define(MYOXUS_FRAME_CARD_TITLE, FrameCardTitle);
  customElements.define(MYOXUS_FRAME_PANEL_BODY, FramePanelBody);
  customElements.define(MYOXUS_FRAME_PANEL_HEADER, FramePanelHeader);
  customElements.define(MYOXUS_FRAMES_SETTING_MENU, FramesSettingMenu);
  customElements.define(MYOXUS_FRAME_PREVIEW, FramePreview);
}
