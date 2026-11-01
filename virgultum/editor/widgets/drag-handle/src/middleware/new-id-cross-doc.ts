import type { BlockStdScope } from "@virgultum/std";
import type { TransformerMiddleware } from "@virgultum/store";

export const newIdCrossDoc =
  (std: BlockStdScope): TransformerMiddleware =>
  ({ slots }) => {
    let samePage = false;

    const beforeImportSliceSubscription = slots.beforeImport.subscribe(
      (payload) => {
        if (payload.type === "slice") {
          samePage = payload.snapshot.pageId === std.store.id;
        }
        if (payload.type === "block" && !samePage) {
          payload.snapshot.id = std.workspace.idGenerator();
        }
      },
    );

    return () => {
      beforeImportSliceSubscription.unsubscribe();
    };
  };
