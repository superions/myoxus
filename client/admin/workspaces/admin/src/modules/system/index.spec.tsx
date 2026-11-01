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

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const translations = enJson as Record<string, string>;
const localeConstants = vi.hoisted(() => {
  const codes = ["en", "de", "fr", "es", "it", "nl"] as const;
  return {
    codes,
    labels: Object.fromEntries(
      codes.map((code) => [code, `com.myoxus.locale.option.${code}`]),
    ),
  };
});
const tMock = vi.fn((key: string) => translations[key] ?? key);

vi.mock("@myoxus/i18n", () => ({
  SUPPORTED_LANGUAGE_CODES: localeConstants.codes,
  SUPPORTED_LANGUAGE_LABEL_KEYS: localeConstants.labels,
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in translations,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));
vi.mock("../common", () => ({
  useServerConfig: () => ({
    version: "0.38.0",
    name: "Myoxus Test",
    baseUrl: "https://example.invalid",
    deploymentType: "Standalone",
  }),
}));

const appConfig = vi.hoisted(() => ({
  patched: {} as Record<string, Record<string, unknown>>,
  update: vi.fn(),
  dirtyModules: new Set<string>(),
  saveGroup: vi.fn(),
}));
vi.mock("../settings/use-app-config", () => ({
  useAppConfig: () => ({
    appConfig: {},
    patchedAppConfig: appConfig.patched,
    schema: null,
    update: appConfig.update,
    saveGroup: appConfig.saveGroup,
    saveField: vi.fn(),
    resetGroup: vi.fn(),
    isGroupDirty: (module: string) => appConfig.dirtyModules.has(module),
    isGroupSaving: () => false,
    getGroupVersion: () => 0,
    fieldErrorsByPath: {},
  }),
}));
vi.mock("../settings/config-form-fields", () => {
  const field =
    (type: string) =>
    ({
      field,
      label,
      desc,
      options,
      labels,
    }: {
      field: string;
      label?: string;
      desc?: string;
      options?: string[];
      labels?: Record<string, string>;
    }) => (
      <div
        data-testid="config-row"
        data-field={field}
        data-label={label}
        data-desc={desc}
        data-type={type}
        data-options={options?.join(",")}
        data-labels={labels ? JSON.stringify(labels) : undefined}
      />
    );
  return {
    ConfigTextField: field("String"),
    ConfigNumberField: field("Number"),
    ConfigBooleanField: field("Boolean"),
    ConfigSelectField: field("Enum"),
    ConfigMultiSelectField: field("MultiSelect"),
    ConfigArrayField: field("Array"),
    ConfigJsonField: field("Object"),
    ConfigCheckboxGroupField: field("CheckboxGroup"),
    YamlOnlyBanner: () => null,
  };
});
vi.mock("../settings/operations/send-test-email", () => ({
  SendTestEmail: () => <div data-testid="send-test-email" />,
}));
vi.mock("./telemetry-categories", () => ({
  TelemetryCategoriesGrid: () => <div data-testid="telemetry-categories" />,
}));
vi.mock("./telemetry-live-stats", () => ({
  TelemetryLiveStats: () => <div data-testid="telemetry-live-stats" />,
}));
vi.mock("./metrics-categories", () => ({
  MetricsCategoriesGrid: () => <div data-testid="metrics-categories" />,
}));
vi.mock("./metrics-live-stats", () => ({
  MetricsLiveStats: () => <div data-testid="metrics-live-stats" />,
}));
vi.mock("./tabs/logging", () => ({
  SystemLoggingTab: () => <div data-testid="system-logging-tab" />,
}));

import { SystemPage } from "./index";

function renderPage(ui: ReactElement = <SystemPage />) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function fields(panel: string) {
  return within(screen.getByTestId(`panel-${panel}`))
    .getAllByTestId("config-row")
    .map((row) => row.dataset.field);
}

describe("SystemPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/adminfrontend/system");
    appConfig.patched = {};
    appConfig.update.mockReset();
    appConfig.dirtyModules.clear();
    appConfig.saveGroup.mockReset();
  });
  afterEach(cleanup);

  test("renders canonical mail fields and clears credential pairs atomically", () => {
    appConfig.patched = {
      mail: {
        smtp_user: "***REDACTED***",
        smtp_pass: "***REDACTED***",
        fallback_smtp: {
          username: "***REDACTED***",
          password: "***REDACTED***",
        },
      },
    };
    renderPage();

    expect(fields("mail")).toEqual(
      expect.arrayContaining([
        "mail/smtp_host",
        "mail/smtp_port",
        "mail/smtp_user",
        "mail/smtp_pass",
        "mail/fallback_smtp.username",
        "mail/fallback_smtp.password",
      ]),
    );
    expect(
      within(screen.getByTestId("panel-mail")).getByTestId("send-test-email"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("clear-primary-smtp-credentials"));
    fireEvent.click(screen.getByTestId("clear-fallback-smtp-credentials"));
    expect(appConfig.update.mock.calls).toEqual([
      ["mail/smtp_user", null],
      ["mail/smtp_pass", null],
      ["mail/fallback_smtp.username", null],
      ["mail/fallback_smtp.password", null],
    ]);
  });
});
