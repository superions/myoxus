import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks

// Track config field render calls to verify which fields are rendered and with
// what props.
const configFieldCalls: Array<Record<string, unknown>> = [];
const useQueryMock = vi.fn();
const mutationTriggers: Record<string, ReturnType<typeof vi.fn>> = {};
const revalidateMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../settings/config-form-fields", () => {
  const field = (type: string) => (props: Record<string, unknown>) => {
    configFieldCalls.push({ ...props, type });
    return (
      <div data-testid={`field-${props.field}`} data-type={type}>
        {String(props.field)}
      </div>
    );
  };
  return {
    ConfigTextField: field("String"),
    ConfigNumberField: field("Number"),
    ConfigBooleanField: field("Boolean"),
    ConfigSelectField: field("Enum"),
    ConfigMultiSelectField: field("Array"),
    ConfigArrayField: field("Array"),
    ConfigJsonField: field("JSON"),
    ConfigCheckboxGroupField: field("CheckboxGroup"),
    ConfigRadioSelectField: field("RadioSelect"),
    ConfigColorField: field("Color"),
    YamlOnlyBanner: () => null,
  };
});

vi.mock("../settings/sensitive", () => ({
  isSensitiveConfigField: () => false,
}));

vi.mock("../../use-query", () => ({
  useQuery: (options?: { query?: { id: string } }) => useQueryMock(options),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    if (!mutationTriggers[mutation.id]) {
      mutationTriggers[mutation.id] = vi.fn().mockResolvedValue({});
    }
    return { trigger: mutationTriggers[mutation.id], isMutating: false };
  },
  useMutateQueryResource: () => revalidateMock,
}));

// Import after mocks

import type { GitSyncTabProps } from "./index";
import { PolicyTab } from "./policy-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

const editableRuntimeFields = new Proxy(
  {},
  {
    get: () => ({
      editable: true,
      databaseWritable: true,
      winningSource: "DATABASE",
      requiresRestart: false,
      sensitive: false,
    }),
  },
) as GitSyncTabProps["configFieldStates"];

// Helpers

function makeProps(overrides?: Partial<GitSyncTabProps>): GitSyncTabProps {
  return {
    appConfig: {
      git_sync: {
        enabled: true,
        mime_allowlist_admin: ["image/png"],
        mime_blocklist_admin: ["application/x-executable"],
        mime_validation_mode: "strict",
        ssh_host_key_policy: "accept_new",
      },
    },
    patchedAppConfig: {
      git_sync: {
        enabled: true,
        mime_allowlist_admin: ["image/png"],
        mime_blocklist_admin: ["application/x-executable"],
        mime_validation_mode: "strict",
        ssh_host_key_policy: "accept_new",
        https_certificate_policy: "strict",
        https_ca_bundle_path: "",
        allowed_hosts: [],
      },
    },
    schema: null,
    onUpdate: vi.fn(),
    onSaveGroup: vi.fn().mockResolvedValue(undefined),
    onResetGroup: vi.fn(),
    isGroupDirty: vi.fn().mockReturnValue(false),
    isGroupSaving: vi.fn().mockReturnValue(false),
    getGroupVersion: vi.fn().mockReturnValue(0),
    fieldErrorsByPath: {},
    configFieldStates: editableRuntimeFields,
    ...overrides,
  };
}

// Tests

describe("PolicyTab — MIME Policy fields (M1-D1)", () => {
  beforeEach(() => {
    configFieldCalls.length = 0;
    useQueryMock.mockImplementation((options?: { query?: { id: string } }) => {
      if (options?.query?.id === "getGitSyncSshHostKeysQuery") {
        return {
          data: {
            gitSyncSshHostKeys: [
              {
                host: "git.example.test",
                port: 22,
                keyType: "ssh-ed25519",
                fingerprintSha256: "SHA256:known-host-fingerprint",
                firstSeenAt: "2026-06-05T08:00:00Z",
                lastSeenAt: "2026-06-05T09:00:00Z",
                source: "accept_new",
                createdBy: null,
                enabled: true,
              },
            ],
          },
          isLoading: false,
        };
      }
      return { data: {}, isLoading: false };
    });
    revalidateMock.mockClear();
    for (const key of Object.keys(mutationTriggers))
      delete mutationTriggers[key];
  });

  afterEach(() => {
    cleanup();
  });

  // P80-FE-01/02: allowlist and blocklist now rendered as chip inputs, not config field JSON fields

  test("clicking Save calls onSaveGroup with gitSync module", () => {
    const onSaveGroup = vi.fn().mockResolvedValue(undefined);
    renderWithProvider(
      <PolicyTab {...makeProps({ isGroupDirty: () => true, onSaveGroup })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveGroup).toHaveBeenCalledWith("git_sync");
  });

  test("Cancel button appears when dirty and calls onResetGroup", () => {
    const onResetGroup = vi.fn();
    renderWithProvider(
      <PolicyTab {...makeProps({ isGroupDirty: () => true, onResetGroup })} />,
    );
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    expect(onResetGroup).toHaveBeenCalledWith("git_sync");
  });

  test("renders ssh_host_key_policy as an enum field with safe options", () => {
    renderWithProvider(<PolicyTab {...makeProps()} />);
    expect(
      screen.getByTestId("field-git_sync/ssh_host_key_policy"),
    ).toBeTruthy();
    const policyCall = configFieldCalls.find(
      (c) => c.field === "git_sync/ssh_host_key_policy",
    );
    expect(policyCall).toBeTruthy();
    expect(policyCall!.type).toBe("Enum");
    expect(policyCall!.options).toEqual([
      "accept_new",
      "strict",
      "insecure_no_verify",
    ]);
    expect(policyCall!.labels).toEqual({
      accept_new: "Accept new and pin",
      strict: "Strict pins only",
      insecure_no_verify: "Insecure: no verification",
    });
  });

  test("retains HTTPS policy and links to global read-only trust", () => {
    renderWithProvider(<PolicyTab {...makeProps()} />);

    const policyCall = configFieldCalls.find(
      (call) => call.field === "git_sync/https_certificate_policy",
    );
    expect(policyCall).toMatchObject({
      type: "Enum",
      options: ["strict", "insecure_no_verify"],
      labels: {
        strict: "Strict verification",
        insecure_no_verify: "Insecure: no verification",
      },
    });
    expect(
      configFieldCalls.find(
        (call) => call.field === "git_sync/https_ca_bundle_path",
      ),
    ).toBeUndefined();
    expect(
      screen
        .getByRole("link", { name: "Global TLS trust" })
        .getAttribute("href"),
    ).toBe("/adminfrontend/security?tab=auth#global-tls");
  });

  test("legacy writable schema cannot restore the Git CA editor", () => {
    renderWithProvider(
      <PolicyTab
        {...makeProps({
          schema: {
            modules: [
              {
                module: "git_sync",
                groups: [
                  {
                    fields: [
                      {
                        key: "https_ca_bundle_path",
                        restart_required: true,
                        databaseWritable: true,
                      },
                    ],
                  },
                ],
              },
            ],
          } as never,
        })}
      />,
    );
    expect(
      configFieldCalls.find(
        (call) => call.field === "git_sync/https_ca_bundle_path",
      ),
    ).toBeUndefined();
  });

  test("insecure HTTPS policy requires allowed hosts and blocks saving", () => {
    renderWithProvider(
      <PolicyTab
        {...makeProps({
          isGroupDirty: () => true,
          patchedAppConfig: {
            git_sync: {
              enabled: true,
              allowed_hosts: [],
              mime_allowlist_admin: ["image/png"],
              mime_blocklist_admin: ["application/x-executable"],
              mime_validation_mode: "strict",
              ssh_host_key_policy: "accept_new",
              https_certificate_policy: "insecure_no_verify",
              https_ca_bundle_path: "",
            },
          },
        })}
      />,
    );
    expect(
      screen.getAllByRole("alert").map((alert) => alert.textContent),
    ).toContain(
      "HTTPS certificate verification can only be disabled when Allowed Git hosts contains at least one explicit host. Saving is blocked until the allowlist is configured.",
    );
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("insecure ssh host-key policy renders a persistent warning", () => {
    renderWithProvider(
      <PolicyTab
        {...makeProps({
          patchedAppConfig: {
            git_sync: {
              enabled: true,
              mime_allowlist_admin: ["image/png"],
              mime_blocklist_admin: ["application/x-executable"],
              mime_validation_mode: "strict",
              ssh_host_key_policy: "insecure_no_verify",
            },
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        "SSH host-key verification is disabled. Use only for short diagnostics and return to accept_new or strict afterwards.",
      ),
    ).toBeTruthy();
  });

  test("known host key actions call server mutations and revalidate", async () => {
    renderWithProvider(<PolicyTab {...makeProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(
      mutationTriggers.disableGitSyncSshHostKeyMutation,
    ).toHaveBeenCalledWith({
      host: "git.example.test",
      port: 22,
      keyType: "ssh-ed25519",
    });
    await waitFor(() => {
      expect(revalidateMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "getGitSyncSshHostKeysQuery" }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      mutationTriggers.deleteGitSyncSshHostKeyMutation,
    ).toHaveBeenCalledWith({
      host: "git.example.test",
      port: 22,
      keyType: "ssh-ed25519",
    });
  });

  // P80-FE-01/02: chips render values from config

  // P80-FE-04: chip removal calls onUpdate
  test("clicking remove button on allowlist chip calls onUpdate with chip removed", () => {
    const onUpdate = vi.fn();
    renderWithProvider(<PolicyTab {...makeProps({ onUpdate })} />);
    const removeBtn = screen.getByRole("button", { name: "Remove image/png" });
    fireEvent.click(removeBtn);
    expect(onUpdate).toHaveBeenCalledWith("git_sync/mime_allowlist_admin", []);
  });

  // P80-FE-04: adding a chip via Enter
  test("pressing Enter in allowlist input adds chip and calls onUpdate", async () => {
    const onUpdate = vi.fn();
    renderWithProvider(<PolicyTab {...makeProps({ onUpdate })} />);
    const input = screen.getByTestId("input-git_sync/mime_allowlist_admin");
    await userEvent.setup().type(input, "text/plain{Enter}");
    expect(onUpdate).toHaveBeenCalledWith("git_sync/mime_allowlist_admin", [
      "image/png",
      "text/plain",
    ]);
  });

  // P80-FE-03: conflict warning shown when same MIME is in both lists
  test("conflict warning shown when allowlist and blocklist share a MIME type", () => {
    const conflictProps = makeProps({
      patchedAppConfig: {
        git_sync: {
          enabled: true,
          mime_allowlist_admin: ["image/png", "text/plain"],
          mime_blocklist_admin: ["text/plain"],
          mime_validation_mode: "strict",
        },
      },
    });
    renderWithProvider(<PolicyTab {...conflictProps} />);
    expect(
      screen.getByTestId("conflict-warning-git_sync/mime_allowlist_admin"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("conflict-warning-git_sync/mime_blocklist_admin"),
    ).toBeTruthy();
  });

  // P80-FE-04: no conflict warning when no overlap

  // P80-FE-04: suggestions dropdown appears on focus

  // ─── P100-H-02i (b): allowed_hosts renders as chip input, not textarea ───
});

// P100-H-02c: allowed_hosts chip input

describe("PolicyTab — allowed_hosts chip input (P100-H-02c)", () => {
  afterEach(() => {
    cleanup();
  });

  function makeHostProps(hosts: string[]): GitSyncTabProps {
    return {
      appConfig: { git_sync: { allowed_hosts: hosts } },
      patchedAppConfig: { git_sync: { allowed_hosts: hosts } },
      onUpdate: vi.fn(),
      onSaveGroup: vi.fn().mockResolvedValue(undefined),
      onResetGroup: vi.fn(),
      isGroupDirty: vi.fn().mockReturnValue(false),
      isGroupSaving: vi.fn().mockReturnValue(false),
      getGroupVersion: vi.fn().mockReturnValue(0),
      fieldErrorsByPath: {},
      configFieldStates: editableRuntimeFields,
    };
  }

  test("test_allowed_hosts_add_chip", async () => {
    const onUpdate = vi.fn();
    renderWithProvider(<PolicyTab {...{ ...makeHostProps([]), onUpdate }} />);
    const input = screen.getByTestId("input-git_sync/allowed_hosts");
    await userEvent.setup().type(input, "bitbucket.org{Enter}");
    expect(onUpdate).toHaveBeenCalledWith("git_sync/allowed_hosts", [
      "bitbucket.org",
    ]);
  });

  test("test_allowed_hosts_remove_chip", () => {
    const onUpdate = vi.fn();
    renderWithProvider(
      <PolicyTab {...{ ...makeHostProps(["github.com"]), onUpdate }} />,
    );
    const removeBtn = screen.getByRole("button", { name: "Remove github.com" });
    fireEvent.click(removeBtn);
    expect(onUpdate).toHaveBeenCalledWith("git_sync/allowed_hosts", []);
  });
});
