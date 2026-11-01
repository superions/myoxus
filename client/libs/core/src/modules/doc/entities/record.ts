import { Entity, LiveData } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import type { DocMeta } from "@virgultum/editor/store";

import type { TagStore } from "../../tag/stores/tag";
import type { DocProperties } from "../../db";
import type { DocPropertiesStore } from "../stores/doc-properties";
import type { DocsStore } from "../stores/docs";

/**
 * # DocRecord
 *
 * Some data you can use without open a doc.
 */
export class DocRecord extends Entity<{ id: string }> {
  id: string = this.props.id;
  constructor(
    private readonly docsStore: DocsStore,
    private readonly docPropertiesStore: DocPropertiesStore,
    private readonly tagStore: TagStore,
  ) {
    super();
  }

  meta$ = LiveData.from<Partial<DocMeta>>(
    this.docsStore.watchDocMeta(this.id),
    {},
  );

  properties$ = LiveData.from<DocProperties>(
    this.docPropertiesStore.watchDocProperties(this.id),
    { id: this.id },
  );

  property$(propertyId: string) {
    return this.properties$.selector((p) => p[propertyId]) as LiveData<
      string | undefined | null
    >;
  }

  customProperty$(propertyId: string) {
    return this.properties$.selector(
      (p) => p["custom:" + propertyId],
    ) as LiveData<string | undefined | null>;
  }

  setCustomProperty(propertyId: string, value: string) {
    this.docPropertiesStore.updateDocProperties(this.id, {
      ["custom:" + propertyId]: value,
    });
  }

  getProperties() {
    return this.docPropertiesStore.getDocProperties(this.id);
  }

  updateProperties(properties: Partial<DocProperties>) {
    return this.docPropertiesStore.updateDocProperties(this.id, properties);
  }

  setProperty<Key extends keyof DocProperties>(
    propertyId: Key,
    value: DocProperties[Key],
  ) {
    this.docPropertiesStore.updateDocProperties(this.id, {
      [propertyId]: value,
    });
  }

  setJournalDate(date: string | null) {
    return this.docsStore.setDocJournalDateSetting(this.id, date);
  }

  setTemplateState(isTemplate: boolean) {
    return this.docsStore.setDocTemplateStateSetting(
      this.id,
      isTemplate,
      undefined,
      isTemplate ? "custom" : undefined,
    );
  }

  setPageWidth(pageWidth: string | null) {
    return this.docsStore.setDocPageWidthSetting(this.id, pageWidth);
  }

  setEdgelessColorTheme(theme: string | null) {
    return this.docsStore.setDocEdgelessColorThemeSetting(this.id, theme);
  }

  setIntegrationType(integrationType: string | null) {
    return this.docsStore.setDocIntegrationTypeSetting(
      this.id,
      integrationType,
    );
  }

  setMeta(meta: Partial<DocMeta>): void {
    this.docsStore.setDocMeta(this.id, meta);
  }

  primaryMode$: LiveData<DocMode> = LiveData.from(
    this.docsStore.watchDocPrimaryModeSetting(this.id),
    "page" as DocMode,
  ).map((mode) => (mode === "edgeless" ? "edgeless" : "page") as DocMode);

  setPrimaryMode(mode: DocMode) {
    return this.docsStore.setDocPrimaryModeSetting(this.id, mode);
  }

  getPrimaryMode() {
    return this.docsStore.getDocPrimaryModeSetting(this.id);
  }

  moveToTrash() {
    return this.setMeta({ trash: true, trashDate: Date.now() });
  }

  restoreFromTrash() {
    return this.setMeta({ trash: false, trashDate: undefined });
  }

  title$ = this.meta$.map((meta) => meta.title ?? "");

  tagState$ = this.tagStore.pageTagState$(this.id);

  tagIds$ = this.tagState$.map((state) => state.ids ?? []);

  trash$ = this.meta$.map((meta) => meta.trash ?? false);

  createdAt$ = this.meta$.map((meta) => meta.createDate);

  updatedAt$ = this.meta$.map((meta) => meta.updatedDate);

  createdBy$ = LiveData.from(
    this.docsStore.watchDocCreatedBySetting(this.id),
    undefined,
  );

  updatedBy$ = LiveData.from(
    this.docsStore.watchDocUpdatedBySetting(this.id),
    undefined,
  );

  journalDate$ = LiveData.from(
    this.docsStore.watchDocJournalDateSetting(this.id),
    undefined,
  );

  isTemplate$ = LiveData.from(
    this.docsStore.watchDocTemplateStateSetting(this.id),
    false,
  );

  templateAttribution$ = LiveData.from(
    this.docsStore.watchDocTemplateAttributionSetting(this.id),
    undefined,
  );

  templateClassification$ = LiveData.from(
    this.docsStore.watchDocTemplateClassification(this.id),
    { category: null, tags: null },
  );

  pageWidth$ = LiveData.from(
    this.docsStore.watchDocPageWidthSetting(this.id),
    undefined,
  );

  edgelessColorTheme$ = LiveData.from(
    this.docsStore.watchDocEdgelessColorThemeSetting(this.id),
    undefined,
  );

  integrationType$ = LiveData.from(
    this.docsStore.watchDocIntegrationTypeSetting(this.id),
    undefined,
  );

  setCreatedAt(createdAt: number) {
    this.setMeta({ createDate: createdAt });
  }

  setUpdatedAt(updatedAt: number) {
    this.setMeta({ updatedDate: updatedAt });
  }
}
