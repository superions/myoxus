// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { BaseStructureTreeNodeProps } from "../../tree/node";
import { LinkedFolderNode } from "./linked-folder";

const state = vi.hoisted(() => ({
  linkedFolder: vi.fn(),
  resolveRedirect: vi.fn(),
  jumpToWorkspaceResource: vi.fn(),
}));
vi.mock("@myoxus/infra", () => ({ useService: () => state }));
vi.mock("@myoxus/core/modules/workspace-content-operation", () => ({
  WorkspaceContentOperationService: class {},
}));
vi.mock("@myoxus/core/components/hooks/use-navigate-helper", () => ({
  useNavigateHelper: () => state,
}));
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock("@myoxus/ui-facade", () => ({ notify: { error: vi.fn() } }));
afterEach(cleanup);

function TestRow({
  name,
  collapsed,
  setCollapsed,
  disabled,
  onClick,
  children,
}: BaseStructureTreeNodeProps) {
  return (
    <div>
      <button
        disabled={disabled}
        onClick={onClick ?? (() => setCollapsed(!collapsed))}
      >
        {name}
      </button>
      {collapsed ? null : children}
    </div>
  );
}

test("opens current source entries, stops a folder cycle and reloads after collapse", async () => {
  let documentName = "Host finden";
  state.linkedFolder.mockImplementation(
    async (workspaceId: string, id: string, expanded: boolean) => ({
      name: id,
      children: !expanded
        ? []
        : id === "NetBox"
          ? [{ workspaceId, id: "Plugins", rowType: "folder", name: "Plugins" }]
          : [
              { workspaceId, id: "host", rowType: "doc", name: documentName },
              {
                workspaceId,
                id: "NetBox",
                rowType: "folder_link",
                name: "Back to NetBox",
              },
            ],
    }),
  );
  const target = { workspaceId: "source", id: "host", kind: "Document" };
  state.resolveRedirect.mockResolvedValue(target);
  render(
    <LinkedFolderNode
      treeNode={TestRow}
      workspaceId="source"
      folderId="NetBox"
    />,
  );
  fireEvent.click(await screen.findByText("NetBox"));
  fireEvent.click(await screen.findByText("Plugins"));
  fireEvent.click(await screen.findByText("Host finden"));
  expect(state.resolveRedirect).toHaveBeenCalledWith({
    workspaceId: "source",
    resource: { id: "host", kind: "Document" },
  });
  expect(
    ((await screen.findByText("Back to NetBox")) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(state.jumpToWorkspaceResource).toHaveBeenCalledWith(target);
  fireEvent.click(screen.getByText("Plugins"));
  documentName = "Host suchen";
  fireEvent.click(await screen.findByText("Plugins"));
  expect(await screen.findByText("Host suchen")).toBeDefined();
  expect(screen.queryByText("Host finden")).toBeNull();
  documentName = "Host prüfen";
  fireEvent(document, new Event("visibilitychange"));
  expect(await screen.findByText("Host prüfen")).toBeDefined();
});
