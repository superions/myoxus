// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */

import { readFileSync } from "node:fs";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  Badge,
  ChartSurface,
  Drawer,
  FieldError,
  FieldLabel,
  FormRow,
  IconButton,
  Modal,
  MyoxusButton,
  Checkbox,
  MyoxusMultiSelect,
  MyoxusNumberInput,
  MyoxusSegmentedControl,
  MyoxusSwitch,
  MyoxusTextarea,
  MyoxusTextInput,
  RadioGroup,
  SettingsDangerZone,
  SettingsDataTable,
  SettingsEmptyState,
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsToolbar,
  Slider,
  SplitPane,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./index";
import { MyoxusSettingsMantineProvider } from "./mantine-provider";

const readUiFacadeSource = () =>
  readFileSync(`${process.cwd()}/client/libs/ui-facade/src/button.tsx`, "utf8");

function expectDefined<T>(value: T | null | undefined, message?: string): T {
  expect(value, message).not.toBeNull();
  expect(value, message).not.toBeUndefined();
  return value as T;
}

function expectExactText(text: string): HTMLElement {
  const element = screen.getByText(text);
  expect(element.textContent).toBe(text);
  return element;
}

function expectElementByRole(
  role: Parameters<typeof screen.getByRole>[0],
  options?: Parameters<typeof screen.getByRole>[1],
): HTMLElement {
  const element = screen.getByRole(role, options);
  expect(element).toBeInstanceOf(HTMLElement);
  return element;
}

function expectRoleAncestor(text: string, role: string): HTMLElement {
  return expectDefined(
    screen.getByText(text).closest(`[data-myoxus-ui-role="${role}"]`),
    `${text} should be rendered inside ${role}`,
  ) as HTMLElement;
}

describe("Mantine-backed settings primitives", () => {
  afterEach(() => cleanup());

  test("render Myoxus settings roles through the Mantine provider", () => {
    const onSwitch = vi.fn();
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsPage title="Appearance" subtitle="Theme and language">
          <SettingsSection title="Theme">
            <SettingsRow name="Dark mode" desc="Use dark colors">
              <MyoxusSwitch checked={false} onChange={onSwitch} />
            </SettingsRow>
            <MyoxusButton>Save</MyoxusButton>
            <SettingsToolbar>
              <MyoxusButton>Toolbar action</MyoxusButton>
            </SettingsToolbar>
            <MyoxusTextInput aria-label="Setting name" value="Default" />
            <Checkbox checked={true} label="Enabled" />
            <SettingsDataTable aria-label="Settings table">
              <tbody>
                <tr>
                  <td>Table row</td>
                </tr>
              </tbody>
            </SettingsDataTable>
            <SettingsNotice title="Server governance">
              Changes stay server-authoritative.
            </SettingsNotice>
            <SettingsEmptyState title="Nothing here" />
            <SettingsDangerZone title="Danger">
              <MyoxusButton variant="error">Delete</MyoxusButton>
            </SettingsDangerZone>
          </SettingsSection>
        </SettingsPage>
      </MyoxusSettingsMantineProvider>,
    );

    expectExactText("Appearance");
    expectExactText("Theme and language");
    expectExactText("Dark mode");
    expectElementByRole("button", { name: "Save" });
    expectElementByRole("textbox", { name: "Setting name" });
    expectElementByRole("table", { name: "Settings table" });
    expectRoleAncestor("Server governance", "settings-notice:info");
    expectRoleAncestor("Nothing here", "settings-empty-state");
    expectRoleAncestor("Dark mode", "settings-row");
    expectRoleAncestor("Danger", "settings-danger-zone");
  });

  test("puts legacy modal test id on visible Mantine content", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <Modal
          open
          title="Settings dialog"
          contentOptions={{
            "data-testid": "setting-modal",
          }}
        >
          Modal body
        </Modal>
      </MyoxusSettingsMantineProvider>,
    );

    expect(screen.getByTestId("setting-modal").dataset.testid).toBe(
      "setting-modal",
    );
    expectElementByRole("dialog", { name: "Settings dialog" });
    expectDefined(
      screen.getByText("Modal body").closest('[data-testid="setting-modal"]'),
    );
    expectRoleAncestor("Settings dialog", "settings-modal-header");
    expect(
      screen.getByRole("button", { name: /close/i }).dataset.myoxusUiRole,
    ).toBe("button:icon-only:28");
  });

  test("normalizes icon-only buttons instead of inheriting parent font weight", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <div style={{ fontWeight: 700 }}>
          <IconButton aria-label="Icon only">×</IconButton>
        </div>
      </MyoxusSettingsMantineProvider>,
    );

    const button = screen.getByRole("button", { name: "Icon only" });
    expect(button.dataset.myoxusUiRole).toBe("button:icon-only:28");
    expect(readUiFacadeSource()).toContain(
      'fontWeight: cssTypographyVar("body-small", "weight", "400"),',
    );
  });

  test("encodes icon-only button roles by rendered control size", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <IconButton aria-label="Small icon" size="16">
          ×
        </IconButton>
        <IconButton aria-label="Sidebar toggle" size="24">
          ×
        </IconButton>
        <IconButton
          aria-label="Styled icon"
          size={22.86}
          style={{ height: 32 }}
        >
          ×
        </IconButton>
      </MyoxusSettingsMantineProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Small icon" }).dataset.myoxusUiRole,
    ).toBe("button:icon-only:16");
    expect(
      screen.getByRole("button", { name: "Sidebar toggle" }).dataset
        .myoxusUiRole,
    ).toBe("button:icon-only:24");
    expect(
      screen.getByRole("button", { name: "Styled icon" }).dataset.myoxusUiRole,
    ).toBe("button:icon-only:32");
  });

  test("normalizes nested segmented control labels with Myoxus roles", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <RadioGroup
          value="one"
          items={[
            {
              value: "one",
              label: "One",
              testId: "radio-one",
              attrs: { "data-myoxus-ui-role": "button:icon-only:test-radio" },
            },
            { value: "two", label: "Two" },
          ]}
          onChange={vi.fn()}
        />
      </MyoxusSettingsMantineProvider>,
    );

    expectRoleAncestor("One", "settings-radio-label");
    expect(screen.getByTestId("radio-one").dataset.testid).toBe("radio-one");
    expect(screen.getByTestId("radio-one").dataset.myoxusUiRole).toBe(
      "button:icon-only:test-radio",
    );
  });

  test("applies segmented control sizing props instead of silently ignoring them", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <RadioGroup
          borderRadius={8}
          gap={6}
          iconMode
          itemHeight={28}
          padding={4}
          value="one"
          items={[
            { value: "one", label: "One", testId: "sized-radio-one" },
            { value: "two", label: "Two", testId: "sized-radio-two" },
          ]}
          onChange={vi.fn()}
        />
      </MyoxusSettingsMantineProvider>,
    );

    const root = screen
      .getByTestId("sized-radio-one")
      .closest('[data-myoxus-ui-role="settings-radio-group"]');
    const label = screen
      .getByTestId("sized-radio-one")
      .closest('[data-myoxus-ui-role="settings-radio-label"]');

    const rootElement = expectDefined(root);
    const labelElement = expectDefined(label);
    expect(getComputedStyle(rootElement).padding).toBe("4px");
    expect(getComputedStyle(rootElement).gap).toBe("6px");
    expect(getComputedStyle(rootElement).borderRadius).toBe("8px");
    expect(getComputedStyle(labelElement).minHeight).toBe("28px");
    expect(getComputedStyle(labelElement).justifyContent).toBe("center");
  });

  test("passes implicit settings-row labels to Mantine slider thumbs", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <SettingsRow name="Base font size">
          <Slider min={12} max={24} value={16} />
        </SettingsRow>
      </MyoxusSettingsMantineProvider>,
    );

    expectElementByRole("slider", { name: "Base font size" });
  });

  test("keeps segmented-control item test ids clickable for theme settings", () => {
    const onChange = vi.fn();
    render(
      <MyoxusSettingsMantineProvider>
        <MyoxusSegmentedControl
          value="light"
          data={[
            { value: "light", label: "Light", testId: "light-theme-trigger" },
            { value: "dark", label: "Dark", testId: "dark-theme-trigger" },
          ]}
          onChange={onChange}
        />
      </MyoxusSettingsMantineProvider>,
    );

    const lightTrigger = screen.getByTestId("light-theme-trigger");
    const darkTrigger = screen.getByTestId("dark-theme-trigger");

    expect(lightTrigger.hasAttribute("aria-pressed")).toBe(false);
    expect(lightTrigger.dataset.active).toBe("true");
    expect(darkTrigger.hasAttribute("aria-pressed")).toBe(false);
    expect(darkTrigger.dataset.active).toBe("false");

    darkTrigger.click();

    expect(onChange).toHaveBeenCalledWith("dark");
  });

  test("keeps status badges on Myoxus theme tokens instead of Mantine defaults", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <Badge tone="success">Ready</Badge>
        <Badge tone="warning">Review</Badge>
      </MyoxusSettingsMantineProvider>,
    );

    const successBadge = screen
      .getByText("Ready")
      .closest('[data-myoxus-ui-role="badge:success"]');
    const warningBadge = screen
      .getByText("Review")
      .closest('[data-myoxus-ui-role="badge:warning"]');

    const successBadgeElement = expectDefined(successBadge);
    const warningBadgeElement = expectDefined(warningBadge);
    expect(successBadgeElement.getAttribute("style")).toContain(
      "--myoxus-background-success-color",
    );
    expect(warningBadgeElement.getAttribute("style")).toContain(
      "--myoxus-background-warning-color",
    );
    expect(successBadgeElement.getAttribute("style")).toContain(
      "--myoxus-text-primary-color",
    );
  });

  test("renders the admin-parity primitive surface through the shared facade", () => {
    render(
      <MyoxusSettingsMantineProvider>
        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
          </TabsList>
          <TabsContent value="general">
            <FormRow
              label="Display name"
              help="Visible in Admin surfaces"
              error="Required"
            >
              <FieldLabel>Label</FieldLabel>
              <MyoxusTextInput aria-label="Name" value="Myoxus" />
              <MyoxusTextarea aria-label="Description" value="Long copy" />
              <MyoxusNumberInput aria-label="Limit" value={5} />
              <MyoxusMultiSelect
                aria-label="Tags"
                data={[{ value: "one", label: "One" }]}
                value={["one"]}
              />
              <FieldError>Error copy</FieldError>
            </FormRow>
            <Badge tone="success">Ready</Badge>
            <StatusDot tone="warning" label="Watch" />
            <ChartSurface>Chart</ChartSurface>
            <SplitPane>
              <div>Left</div>
              <div>Right</div>
            </SplitPane>
          </TabsContent>
        </Tabs>
        <Drawer open={false} title="Details">
          Hidden drawer
        </Drawer>
      </MyoxusSettingsMantineProvider>,
    );

    expectExactText("General");
    expectElementByRole("textbox", { name: "Name" });
    expectElementByRole("textbox", { name: "Description" });
    expectExactText("Ready");
    expectExactText("Watch");
    expectExactText("Chart");
    expectRoleAncestor("Display name", "form-row");
  });
});
