import { useVirgultumDocMeta } from "@myoxus/core/components/hooks/use-virgultum-doc-meta";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useService } from "@myoxus/infra";
import {
  MobileDocScroller,
  MobileDocStrip,
  MobileDocStripItem,
} from "@myoxus/ui-facade";
import { useMemo } from "react";

import { DocCard } from "../../components/doc-card";
import { CollapsibleSection } from "../../components/navigation";

export const RecentDocs = ({ max = 5 }: { max?: number }) => {
  const workspace = useService(WorkspaceService).workspace;
  const allPageMetas = useVirgultumDocMeta(workspace.docCollection);

  const cardMetas = useMemo(() => {
    return [...allPageMetas]
      .filter((meta) => !meta.trash)
      .sort((a, b) => (b.updatedDate ?? 0) - (a.updatedDate ?? 0))
      .slice(0, max);
  }, [allPageMetas, max]);

  if (!cardMetas.length) {
    return null;
  }

  return (
    <CollapsibleSection path={["recent"]} title="Recent" testId="recent-docs">
      <MobileDocScroller
        aria-label="Recent documents"
        data-testid="recent-docs-list"
        data-myoxus-ui-role="mobile-recent-docs-scroller"
      >
        <MobileDocStrip data-myoxus-ui-role="mobile-recent-docs-strip">
          {cardMetas.map((doc) => (
            <MobileDocStripItem
              key={doc.id}
              data-myoxus-ui-role="mobile-recent-docs-strip-item"
            >
              <DocCard meta={doc} />
            </MobileDocStripItem>
          ))}
        </MobileDocStrip>
      </MobileDocScroller>
    </CollapsibleSection>
  );
};
