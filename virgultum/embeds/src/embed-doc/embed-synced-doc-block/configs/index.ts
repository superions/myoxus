import {
  EmbedSyncedDocBlockSchema,
  type EmbedSyncedDocModel,
} from "@virgultum/core/models";
import {
  type BlockStdScope,
  ConfigExtensionFactory,
} from "@virgultum/core/runtime";

export type EmbedSyncedDocConfig = {
  mountEdgelessHeader: (
    anchor: HTMLElement,
    context: {
      model: EmbedSyncedDocModel;
      std: BlockStdScope;
    },
  ) => () => void;
};

export const EmbedSyncedDocConfigExtension =
  ConfigExtensionFactory<EmbedSyncedDocConfig>(
    EmbedSyncedDocBlockSchema.model.flavour,
  );
