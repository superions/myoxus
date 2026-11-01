/**
 * @vitest-environment happy-dom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const createMcpApiKey = vi.fn(async (_name: string, scopes: string[]) => ({
  id: "key-1",
  name: "mcp:workspace-1",
  key: "myoxus_test",
  scopes,
}));

const workspaceService = {
  workspace: { id: "workspace-1", name$: "Product" },
};
const serverService = { server: { baseUrl: "https://myoxus.test" } };
const accessTokenService = {
  mcpApiKeys$: [],
  isRevalidating$: false,
  error$: null,
  revalidate: vi.fn(),
  createMcpApiKey,
  revokeMcpApiKey: vi.fn(),
};

vi.mock("@myoxus/core/components/hooks/myoxus-async-hooks", () => ({
  useAsyncCallback: (callback: unknown) => callback,
}));

vi.mock("@myoxus/core/modules/server", () => ({
  AccessTokenService: class AccessTokenService {},
  ServerService: class ServerService {},
}));

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class WorkspaceService {},
}));

vi.mock("@myoxus/infra", () => ({
  useLiveData: (value: unknown) => value,
  useService: (Service: { name: string }) => {
    if (Service.name === "WorkspaceService") return workspaceService;
    if (Service.name === "ServerService") return serverService;
    return accessTokenService;
  },
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key: string) => () => key,
      },
    ),
}));

vi.mock("@myoxus/icons/react", () => ({
  McpIcon: () => <span aria-hidden="true" />,
}));

vi.mock("../../../primitives", () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionControl: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AccordionItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AccordionPanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  ErrorMessage: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MonoText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  notify: { error: vi.fn(), success: vi.fn() },
  SettingsControlEmpty: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsListItemMeta: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsSection: ({
    actions,
    children,
    title,
  }: {
    actions?: ReactNode;
    children: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {actions}
      {children}
    </section>
  ),
  SettingsSwitchRow: ({
    checked,
    disabled,
    label,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    label: ReactNode;
    onChange: (checked: boolean) => void;
  }) => (
    <label>
      {label}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  ),
  Skeleton: () => <div>loading</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TerminalPanel: ({ children }: { children: ReactNode }) => (
    <pre>{children}</pre>
  ),
}));

vi.mock("../setting", () => ({
  IntegrationSettingHeader: ({ name }: { name: ReactNode }) => (
    <header>{name}</header>
  ),
}));

vi.mock("@myoxus/error", () => ({
  UserFriendlyError: { fromAny: (error: unknown) => error },
}));

import { McpServerSettingPanel } from "./setting-panel";

afterEach(() => {
  cleanup();
  createMcpApiKey.mockClear();
  accessTokenService.revalidate.mockClear();
});

describe("MCP optional write scopes", () => {
  test("keeps workspace write off and submits each selected scope independently", async () => {
    render(<McpServerSettingPanel />);

    for (const label of [
      "read:calendar",
      "write:docs",
      "write:calendar",
      "com.myoxus.integration.mcp-server.scope.workspace-write.title",
      "calendar_events_list",
      "calendar_event_delete",
    ]) {
      expect(screen.getByText(label).textContent).toBe(label);
    }

    const calendarWrite = screen.getByLabelText(
      "com.myoxus.integration.calendar.name: com.myoxus.integration.mcp-server.scope.write.title",
    );
    const workspaceWrite = screen.getByLabelText(
      "com.myoxus.integration.mcp-server.scope.workspace-write.title",
    );
    expect((workspaceWrite as HTMLInputElement).checked).toBe(false);
    fireEvent.click(workspaceWrite);
    fireEvent.click(calendarWrite);
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.integration.mcp-server.token.create",
      }),
    );

    await waitFor(() => expect(createMcpApiKey).toHaveBeenCalledOnce());
    expect(createMcpApiKey).toHaveBeenCalledWith("mcp:workspace-1", [
      "read:workspaces",
      "read:docs",
      "read:calendar",
      "write:docs",
      "write:workspaces",
    ]);
  });
});
