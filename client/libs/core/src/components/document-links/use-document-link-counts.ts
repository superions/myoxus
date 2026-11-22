// SPDX-License-Identifier: AGPL-3.0-or-later
import { DocLinksService } from "../../modules/doc-link";
import { useLiveData, useServices } from "@myoxus/infra";
import { useEffect } from "react";

export function useDocumentLinkCounts(enabled = true) {
  const { docLinksService } = useServices({ DocLinksService });
  const backlinks = useLiveData(docLinksService.backlinks.backlinks$);
  const databaseReferences = useLiveData(
    docLinksService.backlinks.databaseReferences$,
  );
  const links = useLiveData(docLinksService.links.links$);
  const backlinksLoaded = useLiveData(docLinksService.backlinks.isLoaded$);
  const linksLoaded = useLiveData(docLinksService.links.isLoaded$);
  useEffect(() => {
    if (!enabled) return;
    const releaseBacklinks = docLinksService.backlinks.acquireLoadDemand();
    const releaseLinks = docLinksService.links.acquireLoadDemand();
    return () => {
      releaseBacklinks();
      releaseLinks();
    };
  }, [docLinksService, enabled]);
  const backlinkCount =
    enabled && backlinksLoaded
      ? backlinks.length + databaseReferences.length
      : undefined;
  const outgoingCount = enabled && linksLoaded ? links.length : undefined;
  return {
    backlinkCount,
    outgoingCount,
    totalCount:
      backlinkCount === undefined || outgoingCount === undefined
        ? undefined
        : backlinkCount + outgoingCount,
  };
}
