import { AuthService } from "@myoxus/core/modules/server";
import { useLiveData, useService } from "@myoxus/infra";
import {
  HeaderActionDivider,
  HeaderActionGroup,
  HeaderActionPrioritySlot,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";

import { ImportTemplateButton } from "./import-template";
import { PresentButton } from "./present";
import { SignIn } from "./sign-in";
import { PublishPageUserAvatar } from "./user-avatar";

export type ShareHeaderRightItemProps = {
  publishMode: DocMode;
  isTemplate?: boolean;
  templateName?: string;
  snapshotUrl?: string;
};

const ShareHeaderRightItem = ({
  publishMode,
  isTemplate,
  templateName,
  snapshotUrl,
}: ShareHeaderRightItemProps) => {
  const loginStatus = useLiveData(useService(AuthService).session.status$);
  const authenticated = loginStatus === "authenticated";
  return (
    <HeaderActionGroup data-myoxus-ui-role="share-header-actions">
      {isTemplate ? (
        <ImportTemplateButton
          name={templateName ?? ""}
          snapshotUrl={snapshotUrl ?? ""}
        />
      ) : (
        <>
          {authenticated ? null : <SignIn />}
          {publishMode === "edgeless" ? (
            <HeaderActionPrioritySlot priority="wide">
              <PresentButton />
            </HeaderActionPrioritySlot>
          ) : null}
          {authenticated ? (
            <>
              <HeaderActionDivider
                priority={publishMode === "edgeless" ? "wide" : "always"}
              />
              <PublishPageUserAvatar />
            </>
          ) : null}
        </>
      )}
    </HeaderActionGroup>
  );
};

export default ShareHeaderRightItem;
