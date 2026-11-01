import { useI18n } from "@myoxus/i18n";
import {
  Modal,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import type { RefObject } from "react";

import {
  DocumentBacklinksList,
  DocumentOutgoingLinksList,
  useDocumentLinkCounts,
} from "./document-links-content";

type DocumentLinksDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

const TAB_BACKLINKS = "backlinks";
const TAB_OUTGOING = "outgoing";

function tabLabel(label: string, count: number | undefined) {
  return count === undefined ? label : `${label} · ${count}`;
}

export function DocumentLinksDialog({
  open,
  onOpenChange,
  returnFocusRef,
}: DocumentLinksDialogProps) {
  const t = useI18n();
  const { backlinkCount, outgoingCount } = useDocumentLinkCounts(open);

  return (
    <Modal
      contentOptions={{
        "aria-label": t["com.myoxus.document-links.title"](),
        "data-testid": "document-links-dialog",
      }}
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title={t["com.myoxus.document-links.title"]()}
      width="xl"
    >
      {open ? (
        <Tabs defaultValue={TAB_BACKLINKS} layout="embedded">
          <TabsList variant="panel">
            <TabsTrigger
              grow
              value={TAB_BACKLINKS}
              variant="panel"
              data-testid="document-links-tab-backlinks"
            >
              {tabLabel(
                t["com.myoxus.page-properties.backlinks"](),
                backlinkCount,
              )}
            </TabsTrigger>
            <TabsTrigger
              grow
              value={TAB_OUTGOING}
              variant="panel"
              data-testid="document-links-tab-outgoing"
            >
              {tabLabel(
                t["com.myoxus.page-properties.outgoing-links"](),
                outgoingCount,
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent layout="stack" value={TAB_BACKLINKS}>
            <DocumentBacklinksList />
          </TabsContent>
          <TabsContent layout="stack" value={TAB_OUTGOING}>
            <DocumentOutgoingLinksList />
          </TabsContent>
        </Tabs>
      ) : null}
    </Modal>
  );
}
