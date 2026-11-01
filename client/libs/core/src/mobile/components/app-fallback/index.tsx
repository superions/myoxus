import { MobileAppFallback } from "@myoxus/ui-facade";

import { WorkspaceSelector } from "../workspace-selector";

export const AppFallback = () => {
  return <MobileAppFallback workspaceSelector={<WorkspaceSelector />} />;
};
