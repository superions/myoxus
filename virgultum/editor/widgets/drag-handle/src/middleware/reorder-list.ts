import { correctNumberedListsOrderToPrev } from "@virgultum/block-list";
import { ListBlockModel } from "@virgultum/model";
import { matchModels } from "@virgultum/shared/utils";
import type { BlockStdScope } from "@virgultum/std";
import type { TransformerMiddleware } from "@virgultum/store";

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
