import { Service } from "@myoxus/infra";

import { WORKSPACE_TAG_COLOR_ROLES } from "../color-role";
import { TagList } from "../entities/tag-list";

export class TagService extends Service {
  tagList = this.framework.createEntity(TagList);

  /** Server-owned semantic roles; the Facade resolves their visual tokens. */
  /** Available semantic roles; localized labels are supplied by tag UI. */
  readonly tagColors = WORKSPACE_TAG_COLOR_ROLES;

  randomTagColor() {
    const randomIndex = Math.floor(Math.random() * this.tagColors.length);
    return this.tagColors[randomIndex];
  }
}
