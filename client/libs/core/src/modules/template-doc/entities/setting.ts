import { Entity } from "@myoxus/infra";

import { TemplateDocService } from "../services/template-doc";
import type { TemplateDocSettingStore } from "../store/setting";

export class TemplateDocSetting extends Entity {
  constructor(private readonly store: TemplateDocSettingStore) {
    super();
  }

  loading$ = this.store.watchIsLoading();
  setting$ = this.store.watchSetting();
  enablePageTemplate$ = this.store.watchSettingKey("enablePageTemplate");
  pageTemplateDocId$ = this.store.watchSettingKey("pageTemplateId");
  journalTemplateDocId$ = this.store.watchSettingKey("journalTemplateId");
  builtinReconcileMigrationDone$ = this.store.watchSettingKey(
    "builtinReconcileMigrationDone",
  );
  builtinTemplateInstanceDocIds$ = this.store.watchSettingKey(
    "builtinTemplateInstanceDocIds",
  );
  userTrashedBuiltinSlugs$ = this.store.watchSettingKey(
    "userTrashedBuiltinSlugs",
  );

  togglePageTemplate(enable: boolean) {
    this.store.updateSetting("enablePageTemplate", enable);
  }

  private async assertDefaultSource(id?: string) {
    await this.loading$.waitFor((loading) => !loading);
    // Resolve lazily: the catalogue creates this settings entity itself.
    if (id)
      await this.framework
        .get(TemplateDocService)
        .assertDocumentTemplateSource(id);
  }

  async updatePageTemplateDocId(id?: string) {
    await this.assertDefaultSource(id);
    this.store.updateSetting("pageTemplateId", id);
  }

  async replacePageTemplateDocId(expected: string, replacement?: string) {
    if (this.pageTemplateDocId$.value !== expected) return false;
    await this.assertDefaultSource(replacement);
    if (this.pageTemplateDocId$.value !== expected) return false;
    this.store.updateSetting("pageTemplateId", replacement);
    return true;
  }

  async updateJournalTemplateDocId(id?: string) {
    await this.assertDefaultSource(id);
    this.store.updateSetting("journalTemplateId", id);
  }

  async replaceJournalTemplateDocId(expected: string, replacement?: string) {
    if (this.journalTemplateDocId$.value !== expected) return false;
    await this.assertDefaultSource(replacement);
    if (this.journalTemplateDocId$.value !== expected) return false;
    this.store.updateSetting("journalTemplateId", replacement);
    return true;
  }

  markBuiltinReconcileMigrationDone() {
    this.store.updateSetting("builtinReconcileMigrationDone", true);
  }

  setBuiltinTemplateInstanceDocIds(map: Record<string, string>) {
    this.store.updateSetting("builtinTemplateInstanceDocIds", map);
  }

  setUserTrashedBuiltinSlugs(slugs: string[]) {
    this.store.updateSetting("userTrashedBuiltinSlugs", slugs);
  }
}
