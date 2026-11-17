import { correctNumberedListsOrderToPrev } from "@virgultum/content/blocks";
import { ListBlockModel } from "@virgultum/core/models";
import { matchModels } from "@virgultum/core/utils";
import type { BlockStdScope } from "@virgultum/core/runtime";
import type { TransformerMiddleware } from "@virgultum/core/store";

export const reorderList =
  (std: BlockStdScope): TransformerMiddleware =>
  ({ slots }) => {
    const afterImportBlockSubscription = slots.afterImport.subscribe(
      (payload) => {
        if (payload.type === "block") {
          const model = payload.model;
          if (
            matchModels(model, [ListBlockModel]) &&
            model.props.type === "numbered"
          ) {
            const next = std.store.getNext(model);
            correctNumberedListsOrderToPrev(std.store, model);
            if (next) {
              correctNumberedListsOrderToPrev(std.store, next);
            }
          }
        }
      },
    );

    return () => {
      afterImportBlockSubscription.unsubscribe();
    };
  };
