import { Entity, LiveData } from "@myoxus/infra";
import type { TagColorRole } from "@myoxus/ui-facade";

import type { DocsService } from "../../doc";
import { WorkspaceTagAssignmentController } from "../assignment-controller";
import type { TagStore } from "../stores/tag";

export class Tag extends Entity<{ id: string }> {
  id = this.props.id;
  constructor(
    private readonly store: TagStore,
    private readonly docs: DocsService,
  ) {
    super();
  }

  private readonly tagOption$ = LiveData.from(
    this.store.watchTagInfo(this.id),
    undefined,
  ).map((tagInfo) => tagInfo);

  value$ = this.tagOption$.map((tag) => tag?.value || "");

  color$ = this.tagOption$.map((tag) => tag?.color ?? "tag.grey");

  description$ = this.tagOption$.map((tag) => tag?.description ?? "");

  createDate$ = this.tagOption$.map((tag) => tag?.createDate || Date.now());

  updateDate$ = this.tagOption$.map((tag) => tag?.updateDate || Date.now());

  archived$ = this.tagOption$.map((tag) => tag?.archived ?? false);

  rename(value: string) {
    return this.store.renameTag(this.id, value);
  }

  changeColor(color: TagColorRole) {
    return this.store.recolorTag(this.id, color);
  }

  changeDescription(description: string | null) {
    return this.store.updateTagDescription(this.id, description);
  }

  async tag(pageId: string) {
    const pageRecord = this.docs.list.doc$(pageId).value;
    if (!pageRecord) {
      return;
    }
    const current = await this.store.getPageTags(pageId);
    const controller = new WorkspaceTagAssignmentController(
      current,
      (nextIds) => this.store.setPageTags(pageId, nextIds),
    );
    controller.select(this.id);
    return await controller.flush();
  }

  async untag(pageId: string) {
    const pageRecord = this.docs.list.doc$(pageId).value;
    if (!pageRecord) {
      return;
    }
    const controller = new WorkspaceTagAssignmentController(
      await this.store.getPageTags(pageId),
      (nextIds) => this.store.setPageTags(pageId, nextIds),
    );
    controller.deselect(this.id);
    return await controller.flush();
  }

  readonly pageIds$ = LiveData.from(this.store.watchTagPageIds(this.id), []);
}
