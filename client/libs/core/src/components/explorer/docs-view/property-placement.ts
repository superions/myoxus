import { WorkspacePropertyTypes } from "../../workspace-property-types";
import type { generateExplorerPropertyList } from "../properties";

type ExplorerProperty = ReturnType<typeof generateExplorerPropertyList>[number];
type DocListPlacement = "inline" | "stack";

export function getExplorerPropertyDocListPlacement(
  property: ExplorerProperty,
): DocListPlacement | undefined {
  if (property.systemProperty?.showInDocList) {
    return property.systemProperty.showInDocList;
  }

  const workspaceType = property.workspaceProperty?.type;
  if (!workspaceType) {
    return undefined;
  }

  return WorkspacePropertyTypes[workspaceType]?.showInDocList;
}
