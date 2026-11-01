// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DatabaseDocumentPicker,
  type DatabaseDocumentPickerProps,
} from "./document-picker";

const gql = vi.fn();

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => new Proxy({}, { get: (_target, key) => () => String(key) }),
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => ({ gql }),
}));

function render(element: ReactElement) {
  return renderComponent(<MyoxusUIProvider>{element}</MyoxusUIProvider>);
}

function ControlledDocumentPicker({
  onOpenChange,
  ...props
}: Omit<DatabaseDocumentPickerProps, "open" | "onOpenChange"> & {
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <DatabaseDocumentPicker
      {...props}
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange?.(nextOpen);
        setOpen(nextOpen);
      }}
    />
  );
}

beforeEach(() => {
  gql.mockReset();
  gql.mockResolvedValue({
    workspace: {
      searchDocs: [
        {
          docId: "f557255a-13e7-4881-8d2d-04cc948e7b09",
          externalId: "doc-1",
          title: "Project plan",
        },
        {
          docId: "148177f9-f06e-46a7-ad8e-d0b3cf55e892",
          externalId: "doc-2",
          title: "Sprint retrospective",
        },
      ],
    },
  });
});

afterEach(cleanup);

describe("DatabaseDocumentPicker", () => {
  test("queries the permission-filtered workspace search instead of a client document cache", async () => {
    render(
      <DatabaseDocumentPicker
        open
        onOpenChange={() => undefined}
        workspaceId="ws-1"
        currentDocumentId={null}
        onSelect={() => undefined}
      />,
    );

    await waitFor(() => expect(gql).toHaveBeenCalledTimes(1));
    expect(gql.mock.calls[0]?.[0].variables).toEqual({
      id: "ws-1",
      input: { keyword: "", limit: 50, useSemanticSearch: false },
    });

    fireEvent.change(screen.getByTestId("database-document-picker-search"), {
      target: { value: "Sprint" },
    });
    await waitFor(() => expect(gql).toHaveBeenCalledTimes(2));
    expect(gql.mock.calls[1]?.[0].variables.input.keyword).toBe("Sprint");
  });

  test("preserves internal mutation and external route identities", async () => {
    const onSelect = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();
    render(
      <ControlledDocumentPicker
        onOpenChange={onOpenChange}
        workspaceId="ws-1"
        currentDocumentId={null}
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("database-document-picker-select-doc-1"),
      ).not.toBeNull(),
    );
    screen.getByTestId("database-document-picker-select-doc-1").click();
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith({
      id: "f557255a-13e7-4881-8d2d-04cc948e7b09",
      externalId: "doc-1",
      title: "Project plan",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() =>
      expect(screen.queryByTestId("database-document-picker")).toBeNull(),
    );
  });

  test("keeps the current target selected without submitting it again", async () => {
    const onSelect = vi.fn(async () => undefined);
    render(
      <DatabaseDocumentPicker
        open
        onOpenChange={() => undefined}
        workspaceId="ws-1"
        currentDocumentId="f557255a-13e7-4881-8d2d-04cc948e7b09"
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("database-document-picker-select-doc-1"),
      ).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByTestId("database-document-picker-select-doc-1"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("database-document-picker-already-linked"),
      ).not.toBeNull(),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("clears a property link without exposing delete-on-unlink", async () => {
    const onClear = vi.fn(async () => undefined);
    render(
      <ControlledDocumentPicker
        workspaceId="ws-1"
        currentDocumentId="doc-1"
        onSelect={() => undefined}
        onClear={onClear}
      />,
    );

    screen.getByTestId("database-document-picker-clear").click();
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("database-document-picker")).toBeNull(),
    );
    expect(
      screen.queryByTestId("database-document-picker-delete-on-unlink"),
    ).toBeNull();
  });
});
