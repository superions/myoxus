import type { MyoxusTextAttributes } from "@virgultum/editor/shared/types";
import {
  type DeltaInsert,
  Text,
  type Workspace,
} from "@virgultum/editor/store";
import { useCallback } from "react";

export function useReferenceLinkHelper(docCollection: Workspace) {
  const addReferenceLink = useCallback(
    (pageId: string, referenceId: string) => {
      const page = docCollection?.getDoc(pageId)?.getStore();
      if (!page) {
        return;
      }
      const text = new Text([
        {
          insert: " ",
          attributes: {
            reference: {
              type: "Subpage",
              pageId: referenceId,
            },
          },
        },
      ] as DeltaInsert<MyoxusTextAttributes>[]);
      const [frame] = page.getModelsByFlavour("myoxus:note");

      frame && page.addBlock("myoxus:paragraph", { text }, frame.id);
    },
    [docCollection],
  );

  return {
    addReferenceLink,
  };
}
