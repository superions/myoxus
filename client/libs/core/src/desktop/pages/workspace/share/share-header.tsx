import ShareHeaderRightItem from "@myoxus/core/components/cloud/share-header-right-item";
import { VirgultumHeaderTitle } from "@myoxus/core/editor/virgultum/doc-header/title";
import { EditorModeSwitch } from "@myoxus/core/editor/virgultum/mode-switch";
import {
  PublicShareHeaderBar,
  PublicShareHeaderSpacer,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";

export function ShareHeader({
  publishMode,
  isTemplate,
  templateName,
  snapshotUrl,
}: {
  pageId: string;
  publishMode: DocMode;
  isTemplate?: boolean;
  templateName?: string;
  snapshotUrl?: string;
}) {
  return (
    <PublicShareHeaderBar>
      <EditorModeSwitch />
      <VirgultumHeaderTitle />
      <PublicShareHeaderSpacer />
      <ShareHeaderRightItem
        publishMode={publishMode}
        isTemplate={isTemplate}
        snapshotUrl={snapshotUrl}
        templateName={templateName}
      />
    </PublicShareHeaderBar>
  );
}
