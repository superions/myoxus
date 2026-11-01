import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks

const configFieldCalls: Array<Record<string, unknown>> = [];

vi.mock("../settings/config", () => ({
  ALL_CONFIG_DESCRIPTORS: {
    git_sync: {
      network_timeout_secs: { desc: "Network timeout", type: "Number" },
      local_timeout_secs: { desc: "Local timeout", type: "Number" },
      clone_depth: { desc: "Clone depth", type: "Number" },
      push_max_retries: { desc: "Push retries", type: "Number" },
      commit_author_name: { desc: "Author name", type: "String" },
      commit_author_email: { desc: "Author email", type: "String" },
      parallel_conversion_threshold: {
        desc: "Parallel threshold",
        type: "Number",
      },
      max_docs_per_sync: { desc: "Max docs", type: "Number" },
    },
  },
}));

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

// Import after mocks

import type { GitSyncTabProps } from "./index";
import { OperationsTab } from "./operations-tab";

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
        network_timeout_secs: 120,
        local_timeout_secs: 30,
        clone_depth: 1,
        push_max_retries: 1,
        commit_author_name: "Myoxus",
        commit_author_email: "sync@myoxus.local",
        parallel_conversion_threshold: 10,
        max_docs_per_sync: 0,
      },
    },
    patchedAppConfig: {
      git_sync: {
        network_timeout_secs: 120,
        local_timeout_secs: 30,
        clone_depth: 1,
        push_max_retries: 1,
        commit_author_name: "Myoxus",
        commit_author_email: "sync@myoxus.local",
        parallel_conversion_threshold: 10,
        max_docs_per_sync: 0,
      },
    },
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

describe("OperationsTab", () => {
  beforeEach(() => {
    configFieldCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("clicking Save calls onSaveGroup with gitSync module", () => {
    const onSaveGroup = vi.fn().mockResolvedValue(undefined);
    renderWithProvider(
      <OperationsTab
        {...makeProps({ isGroupDirty: () => true, onSaveGroup })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveGroup).toHaveBeenCalledWith("git_sync");
  });

  test("Cancel button appears when dirty and calls onResetGroup", () => {
    const onResetGroup = vi.fn();
    renderWithProvider(
      <OperationsTab
        {...makeProps({ isGroupDirty: () => true, onResetGroup })}
      />,
    );
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    expect(onResetGroup).toHaveBeenCalledWith("git_sync");
  });
});
