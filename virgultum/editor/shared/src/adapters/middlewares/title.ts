import type { DocMeta, TransformerMiddleware } from "@virgultum/store";

export const titleMiddleware =
  (metas: Array<Pick<DocMeta, "id" | "title">>): TransformerMiddleware =>
  ({ slots, adapterConfigs }) => {
    const beforeExportSubscription = slots.beforeExport.subscribe(() => {
      for (const meta of metas) {
        adapterConfigs.set("title:" + meta.id, meta.title);
      }
    });

    return () => {
      beforeExportSubscription.unsubscribe();
    };
  };
