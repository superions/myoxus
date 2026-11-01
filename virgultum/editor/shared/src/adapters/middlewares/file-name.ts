import type { TransformerMiddleware } from "@virgultum/store";

export const fileNameMiddleware =
  (fileName?: string): TransformerMiddleware =>
  ({ slots }) => {
    const beforeImportSubscription = slots.beforeImport.subscribe((payload) => {
      if (payload.type !== "page") {
        return;
      }
      if (!fileName) {
        return;
      }
      payload.snapshot.meta.title = fileName;
      payload.snapshot.blocks.props.title = {
        "$virgultum:internal:text$": true,
        delta: [
          {
            insert: fileName,
          },
        ],
      };
    });

    return () => {
      beforeImportSubscription.unsubscribe();
    };
  };
