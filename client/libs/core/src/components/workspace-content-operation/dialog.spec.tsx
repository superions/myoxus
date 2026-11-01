// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  WorkspaceContentBlockerType,
  WorkspaceContentErrorCodeType,
  WorkspaceContentGitSyncChoiceType,
  WorkspaceContentOperationKindType,
  WorkspaceContentOperationStatusType,
  WorkspaceContentResourceKindType,
  type WorkspaceContentOperationProjectionFragment,
} from "@myoxus/graphql";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceContentOperationDialog } from "./dialog";

const service = vi.hoisted(() => ({
  availability$: {
    value: {
      status: "available",
      checkedAt: Date.now(),
      capabilities: { read: true, organize: true, transfer: true },
      gitConfigured: false,
      targets: [
        { id: "target-a", flavour: "server-a", name: "Alpha workspace" },
      ],
    },
  },
  refreshAvailability: vi.fn(async () => undefined),
  preflight: vi.fn(async () => ({
    operation: {
      id: "operation-1",
      kind: WorkspaceContentOperationKindType.Move,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: "target-a",
      status: "Previewed",
      revision: "revision-1",
      errorCode: null,
      errorMessage: null,
      errorPhase: null,
      originOperationId: null,
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
    },
    revision: "revision-1",
    blockers: [WorkspaceContentBlockerType.PermissionDenied],
    missingResources: [],
    conflicts: [],
    membershipImpactCount: 0,
    membershipImpacts: [],
    resourceCount: 1,
    resourceCounts: [
      { kind: WorkspaceContentResourceKindType.Document, count: 1 },
    ],
    requiredConfirmations: [],
  })),
  operation: vi.fn(
    async (
      id: string,
    ): Promise<WorkspaceContentOperationProjectionFragment> => ({
      id,
      kind: WorkspaceContentOperationKindType.Copy,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: "target-a",
      status: WorkspaceContentOperationStatusType.Succeeded,
      revision: "revision-1",
      errorCode: null,
      errorMessage: null,
      errorPhase: null,
      originOperationId: null,
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
    }),
  ),
  retry: vi.fn(),
  undo: vi.fn(),
  execute: vi.fn(),
  createLinkPlacement: vi.fn(),
}));
const translations = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get: (_, key) => () => String(key),
      },
    ),
);

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: () => service.availability$.value,
    useService: () => service,
  };
});

vi.mock("@myoxus/ui-facade", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Badge: Container,
    Button: ({
      children,
      disabled,
      onClick,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Checkbox: ({
      checked,
      label,
      onChange,
    }: {
      checked: boolean;
      label: string;
      onChange: (event: unknown, checked: boolean) => void;
    }) => (
      <label>
        <input
          checked={checked}
          onChange={(event) => onChange(event, event.target.checked)}
          type="checkbox"
        />
        {label}
      </label>
    ),
    Group: Container,
    Loading: () => <span>loading</span>,
    Modal: ({ children, title }: { children?: ReactNode; title: string }) => (
      <div aria-label={title} role="dialog">
        {children}
      </div>
    ),
    MyoxusText: Container,
    MyoxusTextInput: ({
      label,
      onChange,
      value,
    }: {
      label: string;
      onChange: (value: string) => void;
      value: string;
    }) => (
      <label>
        {label}
        <input
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        />
      </label>
    ),
    Select: ({
      data,
      label,
      onChange,
      value,
    }: {
      data: Array<{ label: string; value: string }>;
      label: string;
      onChange: (value: string) => void;
      value: string;
    }) => (
      <label>
        {label}
        <select
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          <option value="" />
          {data.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    ),
    SettingsNotice: ({
      children,
      role,
      title,
    }: {
      children?: ReactNode;
      role?: string;
      title?: string;
    }) => (
      <div role={role}>
        {title}
        {children}
      </div>
    ),
    Stack: Container,
    Stepper: ({
      ariaLabel,
      children,
    }: {
      ariaLabel: string;
      children?: ReactNode;
    }) => <div aria-label={ariaLabel}>{children}</div>,
    StepperStep: ({ label }: { label: string }) => <span>{label}</span>,
  };
});

vi.mock("@myoxus/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/i18n")>()),
  useI18n: () => translations,
}));

vi.mock("@myoxus/core/components/hooks/use-navigate-helper", () => ({
  useNavigateHelper: () => ({}),
}));

describe("WorkspaceContentOperationDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    service.availability$.value.gitConfigured = false;
    window.history.replaceState(null, "", "/");
  });

  test("renders the server target and keeps a blocked preview non-confirmable", async () => {
    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        kind={WorkspaceContentOperationKindType.Move}
        selection={{
          type: "resources",
          resources: [
            {
              id: "doc-1",
              kind: WorkspaceContentResourceKindType.Document,
            },
          ],
        }}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "com.myoxus.workspace-content-operation.target.label",
      }),
      { target: { value: "target-a" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.workspace-content-operation.action.continue",
      }),
    );

    expect(
      await screen.findByText(
        "com.myoxus.workspace-content-operation.blocker.permission-denied",
      ),
    ).not.toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "com.myoxus.workspace-content-operation.action.confirm",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(service.preflight).toHaveBeenCalledWith({
      kind: WorkspaceContentOperationKindType.Move,
      selection: {
        type: "resources",
        resources: [
          {
            id: "doc-1",
            kind: WorkspaceContentResourceKindType.Document,
          },
        ],
      },
      targetWorkspaceId: "target-a",
      extractWorkspaceName: undefined,
      linkPlacement: undefined,
    });
  });

  test("reloads durable progress from the server without restoring client state", async () => {
    const operationId = "018f65a7-3c2b-7d11-8a22-123456789abc";
    window.history.replaceState(
      null,
      "",
      `/workspace/source/all?workspaceContentOperation=${operationId}`,
    );

    const close = vi.fn();
    render(
      <WorkspaceContentOperationDialog
        close={close}
        resumeOperationId={operationId}
      />,
    );

    expect(
      await screen.findByText("com.myoxus.common.status.completed"),
    ).not.toBeNull();
    expect(service.operation).toHaveBeenCalledWith(operationId);
    expect(
      new URL(window.location.href).searchParams.has(
        "workspaceContentOperation",
      ),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.workspace-content-operation.action.close",
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(
      new URL(window.location.href).searchParams.has(
        "workspaceContentOperation",
      ),
    ).toBe(false);
  });

  test("reviews the explicit Git choice again instead of executing a stale preview", async () => {
    service.availability$.value.gitConfigured = true;
    const base = await service.preflight();
    service.preflight.mockClear();
    const preview = {
      ...base,
      operation: {
        ...base.operation,
        kind: WorkspaceContentOperationKindType.ExtractFolder,
      },
      blockers: [],
    };
    service.preflight
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, revision: "disconnect-revision" });
    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        kind={WorkspaceContentOperationKindType.ExtractFolder}
        selection={{
          type: "folder",
          folderId: "folder",
          label: "Chosen folder",
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.workspace-content-operation.action.continue",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "com.myoxus.workspace-content-operation.action.back",
      }),
    );
    fireEvent.change(
      screen.getByRole("combobox", {
        name: "com.myoxus.integration.git-sync.name",
      }),
      { target: { value: WorkspaceContentGitSyncChoiceType.Disconnect } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.workspace-content-operation.action.continue",
      }),
    );
    await screen.findByRole("button", {
      name: "com.myoxus.workspace-content-operation.action.confirm",
    });
    expect(service.preflight).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        gitSyncChoice: WorkspaceContentGitSyncChoiceType.Move,
      }),
    );
    expect(service.preflight).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        gitSyncChoice: WorkspaceContentGitSyncChoiceType.Disconnect,
      }),
    );
    expect(service.execute).not.toHaveBeenCalled();
  });

  test("resumes local success and retries only the same pending Git receipt", async () => {
    const completed = {
      id: "018f65a7-3c2b-7d11-8a22-123456789abe",
      kind: WorkspaceContentOperationKindType.ExtractFolder,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: "target-a",
      status: WorkspaceContentOperationStatusType.Succeeded,
      revision: "revision",
      errorCode: null,
      errorMessage: null,
      errorPhase: null,
      originOperationId: null,
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
    };
    service.operation.mockResolvedValueOnce({
      ...completed,
      gitSyncPending: true,
      gitSyncRetryExhausted: true,
      gitSyncErrorCode:
        WorkspaceContentErrorCodeType.XWS_GIT_SYNC_METADATA_AUTH_DENIED,
    });
    service.retry.mockResolvedValueOnce(completed);
    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        resumeOperationId={completed.id}
      />,
    );
    await screen.findByText(
      "com.myoxus.workspace-content-operation.git.pending-move",
    );
    expect(
      (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "com.myoxus.workspace-import.open",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      screen.queryByText(
        "com.myoxus.workspace-content-operation.status.extract-failed-detail",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("com.myoxus.common.status.completed");
    expect(service.retry).toHaveBeenCalledWith(completed.id);
    expect(service.execute).not.toHaveBeenCalled();
    expect(service.preflight).not.toHaveBeenCalled();
  });

  test("resumes a completed Move and submits its fresh server-owned Undo preview", async () => {
    const origin = "018f65a7-3c2b-7d11-8a22-123456789abe";
    const completed = {
      id: origin,
      kind: WorkspaceContentOperationKindType.Move,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: "target-a",
      status: WorkspaceContentOperationStatusType.Succeeded,
      revision: "origin-revision",
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
      errorCode: null,
      errorMessage: null,
      errorPhase: null,
      originOperationId: null,
    };
    service.operation.mockResolvedValueOnce(completed);
    const preview = {
      operation: {
        ...completed,
        id: "018f65a7-3c2b-7d11-8a22-123456789abf",
        sourceWorkspaceId: "target-a",
        targetWorkspaceId: "source-workspace",
        originOperationId: origin,
        status: WorkspaceContentOperationStatusType.Previewed,
        revision: "undo-revision",
      },
      revision: "undo-revision",
      blockers: [],
      missingResources: [],
      conflicts: [],
      membershipImpactCount: 0,
      membershipImpacts: [],
      resourceCount: 1,
      resourceCounts: [],
      requiredConfirmations: [],
    };
    service.undo.mockResolvedValueOnce(preview);
    service.execute.mockResolvedValueOnce({
      ...preview.operation,
      status: WorkspaceContentOperationStatusType.Succeeded,
    });
    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        resumeOperationId={origin}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "com.myoxus.workspace-content-operation.action.confirm",
      }),
    );
    await screen.findByText("com.myoxus.common.status.completed");
    expect(service.undo).toHaveBeenCalledWith(origin);
    expect(service.execute).toHaveBeenCalledWith(preview);
    expect(
      new URL(window.location.href).searchParams.get(
        "workspaceContentOperation",
      ),
    ).toBe(preview.operation.id);
  });

  test("shows the persisted safe failure and does not requeue a compensated Extract", async () => {
    const operationId = "018f65a7-3c2b-7d11-8a22-123456789abd";
    service.operation.mockResolvedValueOnce({
      id: operationId,
      kind: WorkspaceContentOperationKindType.ExtractFolder,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: null,
      status: WorkspaceContentOperationStatusType.Failed,
      revision: "revision-1",
      errorCode: WorkspaceContentErrorCodeType.XWS_ORGANIZER_ORDER_INVALID,
      errorMessage: "workspace content organizer order needs repair",
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
      errorPhase: "organizer_projection",
      originOperationId: null,
    });

    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        resumeOperationId={operationId}
      />,
    );

    expect(
      await screen.findByText(
        "com.myoxus.workspace-content-operation.error.organizer-order-key",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "com.myoxus.workspace-content-operation.error.operation-id",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByText("workspace content organizer order needs repair"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.getByText("com.myoxus.workspace-content-operation.error.phase"),
    ).not.toBeNull();
    expect(service.retry).not.toHaveBeenCalled();
  });

  test.each([
    [
      WorkspaceContentErrorCodeType.XWS_MOVE_WORKSPACE_ROOT_CHANGED,
      "com.myoxus.workspace-content-operation.error.move-workspace-root-changed",
    ],
    [
      WorkspaceContentErrorCodeType.XWS_MOVE_CONTENT_REVISION_CHANGED,
      "com.myoxus.workspace-content-operation.error.move-content-revision-changed",
    ],
  ])("preserves the concrete publication cause %s", async (errorCode, key) => {
    const operationId = "018f65a7-3c2b-7d11-8a22-123456789abe";
    service.operation.mockResolvedValueOnce({
      id: operationId,
      kind: WorkspaceContentOperationKindType.ExtractFolder,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: null,
      status: WorkspaceContentOperationStatusType.CleanupRequired,
      revision: "revision-1",
      errorCode,
      errorMessage: "private payload must not be rendered",
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
      errorPhase: "publication",
      originOperationId: null,
    });
    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        resumeOperationId={operationId}
      />,
    );
    expect(await screen.findByText(key)).not.toBeNull();
    expect(
      screen.getByText("com.myoxus.workspace-content-operation.error.phase"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "com.myoxus.workspace-content-operation.error.operation-id",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByText(
        "com.myoxus.workspace-content-operation.error.preview-stale",
      ),
    ).toBeNull();
    expect(
      screen.queryByText("private payload must not be rendered"),
    ).toBeNull();
  });

  test("requires a fresh preflight for a stale failed receipt", async () => {
    const operationId = "018f65a7-3c2b-7d11-8a22-123456789abe";
    service.operation.mockResolvedValueOnce({
      id: operationId,
      kind: WorkspaceContentOperationKindType.Move,
      sourceWorkspaceId: "source-workspace",
      targetWorkspaceId: "target-a",
      status: WorkspaceContentOperationStatusType.Failed,
      revision: "revision-1",
      errorCode: WorkspaceContentErrorCodeType.XWS_PREFLIGHT_STALE,
      errorMessage: "workspace content publication snapshot is stale",
      gitSyncPending: false,
      gitSyncErrorCode: null,
      gitSyncRetryExhausted: false,
      gitSync: null,
      errorPhase: null,
      originOperationId: null,
    });

    render(
      <WorkspaceContentOperationDialog
        close={vi.fn()}
        resumeOperationId={operationId}
      />,
    );

    expect(
      await screen.findByText(
        "com.myoxus.workspace-content-operation.error.preview-stale",
      ),
    ).not.toBeNull();
    expect(
      screen.queryByText("workspace content publication snapshot is stale"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
