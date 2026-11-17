import {
  EmbedSyncedDocBlockSchema,
  type EmbedSyncedDocModel,
} from "@virgultum/core/models";
import {
  type BlockStdScope,
  ConfigExtensionFactory,
} from "@virgultum/core/runtime";
import type { TemplateResult } from "lit";

export type EmbedSyncedDocConfig = {
  edgelessHeader: (context: {
    model: EmbedSyncedDocModel;
    std: BlockStdScope;
  }) => TemplateResult;
};

export const EmbedSyncedDocConfigExtension =
  ConfigExtensionFactory<EmbedSyncedDocConfig>(
    EmbedSyncedDocBlockSchema.model.flavour,
  );
