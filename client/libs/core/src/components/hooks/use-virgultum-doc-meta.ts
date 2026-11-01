import { DocsService } from "@myoxus/core/modules/doc";
import { useService } from "@myoxus/infra";
import type { DocMeta, Workspace } from "@virgultum/editor/store";
import { useCallback, useMemo } from "react";

import { useAsyncCallback } from "./myoxus-async-hooks";
import { useAllVirgultumDocMeta } from "./use-all-virgultum-doc-meta";
import { useJournalInfoHelper } from "./use-journal";

/**
 * Get pageMetas excluding journal pages without updatedDate
 * If you want to get all pageMetas, use `useAllVirgultumDocMeta` instead
 * @returns
 */
export function useVirgultumDocMeta(docCollection: Workspace) {
  const pageMetas = useAllVirgultumDocMeta(docCollection);
  const { isPageJournal } = useJournalInfoHelper();
  return useMemo(
    () =>
      pageMetas.filter(
        (pageMeta) => !isPageJournal(pageMeta.id) || !!pageMeta.updatedDate,
      ),
    [isPageJournal, pageMetas],
  );
}

export function useDocMetaHelper() {
  const docsService = useService(DocsService);

  const setDocTitle = useAsyncCallback(
    async (docId: string, newTitle: string) => {
      await docsService.changeDocTitle(docId, newTitle);
    },
    [docsService],
  );

  const setDocMeta = useCallback(
    (docId: string, docMeta: Partial<DocMeta>) => {
      const doc = docsService.list.doc$(docId).value;
      if (doc) {
        doc.setMeta(docMeta);
      }
    },
    [docsService],
  );

  const getDocMeta = useCallback(
    (docId: string) => {
      const doc = docsService.list.doc$(docId).value;
      return doc?.meta$.value;
    },
    [docsService],
  );

  return useMemo(
    () => ({
      setDocTitle,
      setDocMeta,
      getDocMeta,
    }),
    [getDocMeta, setDocMeta, setDocTitle],
  );
}
