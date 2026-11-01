import {
  EmbedSyncedDocBlockSchema,
  type EmbedSyncedDocModel,
} from "@virgultum/model";
import { type BlockStdScope, ConfigExtensionFactory } from "@virgultum/std";
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
