import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks

const configFieldCalls: Array<Record<string, unknown>> = [];

vi.mock("../settings/config", () => ({
  ALL_CONFIG_DESCRIPTORS: {
    git_sync: {
      repo_base_dir: { desc: "Base directory", type: "String" },
      max_mirror_storage_mb: { desc: "Max storage", type: "Number" },
      min_free_disk_mb: { desc: "Min free disk", type: "Number" },
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
import { StorageTab } from "./storage-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
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
        repo_base_dir: "/data/git-mirrors",
        max_mirror_storage_mb: 1024,
        min_free_disk_mb: 500,
        storageUsage: {
          usedMb: 200,
          freeDiskMb: 3000,
          repoCount: 5,
        },
      },
    },
    patchedAppConfig: {
      git_sync: {
        repo_base_dir: "/data/git-mirrors",
        max_mirror_storage_mb: 1024,
        min_free_disk_mb: 500,
        storageUsage: {
          usedMb: 200,
          freeDiskMb: 3000,
          repoCount: 5,
        },
      },
    },
    onUpdate: vi.fn(),
    onSaveGroup: vi.fn().mockResolvedValue(undefined),
    onResetGroup: vi.fn(),
    isGroupDirty: vi.fn().mockReturnValue(false),
    isGroupSaving: vi.fn().mockReturnValue(false),
    getGroupVersion: vi.fn().mockReturnValue(0),
    configFieldStates: editableRuntimeFields,
    ...overrides,
    fieldErrorsByPath: overrides?.fieldErrorsByPath ?? {},
  };
}

// Tests

describe("StorageTab", () => {
  beforeEach(() => {
    configFieldCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("projects asynchronously loaded server values into mounted size controls", () => {
    const emptyProps = makeProps({
      appConfig: { git_sync: {} },
      patchedAppConfig: { git_sync: {} },
    });
    const view = renderWithFacade(<StorageTab {...emptyProps} />);

    expect(
      (
        within(
          screen.getByTestId("field-git_sync/max_mirror_storage_mb"),
        ).getByRole("spinbutton") as HTMLInputElement
      ).value,
    ).toBe("");

    view.rerender(
      <MyoxusUIProvider>
        <StorageTab {...makeProps()} />
      </MyoxusUIProvider>,
    );

    expect(
      (
        within(
          screen.getByTestId("field-git_sync/max_mirror_storage_mb"),
        ).getByRole("spinbutton") as HTMLInputElement
      ).value,
    ).toBe("1024");
    expect(
      (
        within(screen.getByTestId("field-git_sync/min_free_disk_mb")).getByRole(
          "spinbutton",
        ) as HTMLInputElement
      ).value,
    ).toBe("500 MB");
    expect(
      within(screen.getByTestId("field-git_sync/min_free_disk_mb"))
        .getByRole("spinbutton")
        .getAttribute("aria-valuenow"),
    ).toBe("500");
  });

  test("renders server storage values, does not invent a fallback, and shows high usage", () => {
    renderWithFacade(<StorageTab {...makeProps()} />);
    expect(screen.getByText("Mirror storage usage")).not.toBeNull();
    expect(screen.getByText(/200 MB \/ 1024 MB used/)).not.toBeNull();
    expect(screen.getByText(/3000 MB free on filesystem/)).not.toBeNull();
    expect(screen.getByText(/Mirror repositories: 5/)).not.toBeNull();

    cleanup();
    renderWithFacade(
      <StorageTab
        {...makeProps({
          appConfig: {},
          patchedAppConfig: {},
        })}
      />,
    );
    expect(screen.getByText("Mirror storage")).not.toBeNull();
    expect(screen.getByText(/0 MB \/ 0 MB used/)).not.toBeNull();
    expect(screen.getByText(/Mirror repositories: 0/)).not.toBeNull();

    cleanup();
    renderWithFacade(
      <StorageTab
        {...makeProps({
          appConfig: {
            git_sync: {
              storageUsage: { usedMb: 10, freeDiskMb: 5000, repoCount: 1 },
            },
          },
          patchedAppConfig: {
            git_sync: {
              storageUsage: { usedMb: 10, freeDiskMb: 5000, repoCount: 1 },
            },
          },
        })}
      />,
    );
    expect(screen.getByText(/Mirror repositories: 1$/)).not.toBeNull();

    cleanup();
    renderWithFacade(
      <StorageTab
        {...makeProps({
          appConfig: {
            git_sync: {
              max_mirror_storage_mb: 100,
              storageUsage: { usedMb: 85, freeDiskMb: 100, repoCount: 3 },
            },
          },
          patchedAppConfig: {
            git_sync: {
              max_mirror_storage_mb: 100,
              storageUsage: { usedMb: 85, freeDiskMb: 100, repoCount: 3 },
            },
          },
        })}
      />,
    );
    expect(screen.getByText("High usage")).not.toBeNull();
  });

  test("dirty save and cancel actions target the gitSync config group", () => {
    const onSaveGroup = vi.fn().mockResolvedValue(undefined);
    const onResetGroup = vi.fn();
    renderWithFacade(
      <StorageTab
        {...makeProps({
          isGroupDirty: () => true,
          onSaveGroup,
          onResetGroup,
        })}
      />,
    );

    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveBtn);
    expect(onSaveGroup).toHaveBeenCalledWith("git_sync");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResetGroup).toHaveBeenCalledWith("git_sync");
  });
});
