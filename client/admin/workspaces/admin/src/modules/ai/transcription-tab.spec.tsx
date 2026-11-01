/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEffect } from "react";
import { SWRConfig } from "swr";

import en from "../../../../../../libs/i18n/src/resources/en.json";

const contract = vi.hoisted(() => ({
  schema: {} as unknown,
  values: {} as unknown,
  loading: false,
  error: undefined as unknown,
  update: vi.fn(),
  mutate: vi.fn(),
  reload: vi.fn(),
  notifyError: vi.fn(),
  fetch: vi.fn(),
  lastCheck: null as unknown,
  nextCheck: null as unknown,
  configured: true,
  enabled: true,
}));

vi.mock("@myoxus/admin/fetch-utils", () => ({ adminFetch: contract.fetch }));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => (en as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("@myoxus/ui-facade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/ui-facade")>()),
  notify: { success: vi.fn(), warning: vi.fn(), error: contract.notifyError },
}));
vi.mock("../settings/use-admin-config-contract", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../settings/use-admin-config-contract")
  >()),
  useAdminConfigContract: () => ({
    schema: contract.schema,
    values: contract.values,
    isLoading: contract.loading,
    schemaError: contract.error,
    valuesError: undefined,
    updateConfig: contract.update,
    mutateValues: contract.mutate,
    reloadServerState: contract.reload,
  }),
}));

import { useAppConfig } from "../settings/use-app-config";
import { TranscriptionTab } from "./transcription-tab";

const defaults = {
  enabled: false,
  endpoint: "",
  model: "",
  api_key: null,
  language: null,
  request_timeout_ms: 120000,
  max_input_bytes: 104857600,
  max_response_bytes: 16777216,
  max_duration_seconds: 7200,
  max_concurrency: 2,
};
const stored = {
  ...defaults,
  enabled: true,
  endpoint: "http://speech.test/v1",
  model: "operator-model",
  api_key: "***REDACTED***",
};
type Values = {
  [K in keyof typeof defaults]: string | number | boolean | null;
};
function snapshot(values: Values, readonlyKey = false) {
  return {
    revision: "test",
    modules: [
      {
        module: "transcription",
        groups: [
          {
            groupKey: "transcription",
            fields: Object.entries(values).map(([key, value]) => ({
              key,
              path: `transcription.${key}`,
              value,
              defaultValue: defaults[key as keyof typeof defaults],
              valueType:
                typeof defaults[key as keyof typeof defaults] === "boolean"
                  ? "Boolean"
                  : typeof defaults[key as keyof typeof defaults] === "number"
                    ? "Number"
                    : "String",
              sensitive: key === "api_key",
              databaseWritable: !(readonlyKey && key === "api_key"),
            })),
          },
        ],
      },
    ],
  };
}
let current: ReturnType<typeof useAppConfig>;
function Harness() {
  const config = useAppConfig();
  useEffect(() => {
    current = config;
  }, [config]);
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        shouldRetryOnError: false,
        dedupingInterval: 0,
      }}
    >
      <MyoxusUIProvider>
        <TranscriptionTab
          key={config.getGroupVersion("transcription")}
          config={config}
        />
      </MyoxusUIProvider>
    </SWRConfig>
  );
}
const modelInput = () =>
  screen.getByLabelText("Model identifier") as HTMLInputElement;
const secretInput = () =>
  screen.getByLabelText(
    en["admin.ai.provider.field.apiKey"],
  ) as HTMLInputElement;
const saveButton = () =>
  screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const assertSecretAbsent = (secret: string) => {
  expect(
    JSON.stringify({
      config: current.appConfig,
      draft: current.patchedAppConfig,
      updates: current.updates,
    }),
  ).not.toContain(secret);
};

beforeEach(() => {
  vi.clearAllMocks();
  contract.schema = snapshot(defaults);
  contract.values = snapshot(stored);
  contract.loading = false;
  contract.error = undefined;
  contract.lastCheck = null;
  contract.nextCheck = {
    successful: true,
    catalogSupported: true,
    modelListed: true,
    error: null,
  };
  contract.configured = true;
  contract.enabled = true;
  contract.fetch.mockImplementation(async (_input, init) => {
    const request = JSON.parse(init.body);
    if (request.operationName === "adminTranscriptionStatus") {
      return new Response(
        JSON.stringify({
          data: {
            admin: {
              transcriptionStatus: {
                capability: {
                  enabled: contract.enabled,
                  configured: contract.configured,
                  status: "NotChecked",
                },
                lastConnectionCheck: contract.lastCheck,
              },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    expect(request.operationName).toBe("adminCheckTranscriptionConnection");
    contract.lastCheck = contract.nextCheck;
    return new Response(
      JSON.stringify({
        data: { admin: { checkTranscriptionConnection: contract.nextCheck } },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  contract.mutate.mockImplementation(async (updater) => {
    contract.values = updater().admin.adminConfigValues;
  });
  contract.update.mockImplementation(async ({ updates }) => {
    contract.lastCheck = null;
    const next: Values = { ...stored };
    for (const update of updates)
      next[update.key as keyof Values] =
        update.key === "api_key" && update.value !== null
          ? "***REDACTED***"
          : update.value;
    return { applied: true, fieldErrors: [], config: snapshot(next) };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("saves the operator model and reads it back without resending the saved key", async () => {
  render(<Harness />);
  expect(secretInput().value).toBe("");
  expect(secretInput().placeholder).toBe(
    en["admin.config.sensitive.configuredPlaceholder"],
  );
  fireEvent.change(modelInput(), { target: { value: "another-model" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(current.getGroupVersion("transcription")).toBe(1));
  expect(contract.update).toHaveBeenCalledExactlyOnceWith({
    updates: [
      { module: "transcription", key: "model", value: "another-model" },
    ],
  });
  expect(modelInput().value).toBe("another-model");
  expect(saveButton().disabled).toBe(true);
  expect(secretInput().value).toBe("");
});

test("replacement saves atomically with ordinary edits and clears only on accepted readback", async () => {
  render(<Harness />);
  fireEvent.change(secretInput(), {
    target: { value: "test-replacement-secret" },
  });
  fireEvent.change(modelInput(), { target: { value: "another-model" } });
  assertSecretAbsent("test-replacement-secret");
  fireEvent.click(saveButton());
  await waitFor(() => expect(current.getGroupVersion("transcription")).toBe(1));
  expect(contract.update).toHaveBeenCalledExactlyOnceWith({
    updates: [
      { module: "transcription", key: "model", value: "another-model" },
      {
        module: "transcription",
        key: "api_key",
        value: "test-replacement-secret",
      },
    ],
  });
  expect(secretInput().value).toBe("");
  assertSecretAbsent("test-replacement-secret");
});

test("explicit removal submits null rather than an empty replacement", async () => {
  render(<Harness />);
  fireEvent.change(secretInput(), {
    target: { value: "discarded-replacement" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: en["admin.transcription.remove-key-override"],
    }),
  );
  expect(secretInput().value).toBe("");
  fireEvent.click(saveButton());
  await waitFor(() => expect(current.getGroupVersion("transcription")).toBe(1));
  expect(contract.update).toHaveBeenCalledExactlyOnceWith({
    updates: [{ module: "transcription", key: "api_key", value: null }],
  });
  expect(current.appConfig.transcription.api_key).toBeNull();
});

test("server rejection retains protected input, exposes advanced errors and permits correction", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  contract.update.mockResolvedValueOnce({
    applied: false,
    config: snapshot(stored),
    fieldErrors: [
      {
        module: "transcription",
        key: "max_concurrency",
        path: "transcription.max_concurrency",
        message: "Limit rejected",
      },
    ],
  });
  render(<Harness />);
  fireEvent.change(secretInput(), {
    target: { value: "test-retained-secret" },
  });
  fireEvent.click(saveButton());
  await screen.findByText("Limit rejected");
  expect(
    screen
      .getByRole("button", { name: "Technical limits" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(current.getGroupVersion("transcription")).toBe(0);
  expect(secretInput().value).toBe("test-retained-secret");
  assertSecretAbsent("test-retained-secret");
  expect(log).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByLabelText(en["admin.transcription.max-concurrency"]),
    { target: { value: "3" } },
  );
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  fireEvent.click(saveButton());
  await waitFor(() => expect(current.getGroupVersion("transcription")).toBe(1));
  expect(secretInput().value).toBe("");
});

test("transport metadata never enters the standard error log and a failed save retains the input", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  contract.update.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), {
      variables: { api_key: "test-retained-secret" },
    }),
  );
  render(<Harness />);
  fireEvent.change(secretInput(), {
    target: { value: "test-retained-secret" },
  });
  fireEvent.click(saveButton());
  await waitFor(() => expect(contract.notifyError).toHaveBeenCalledTimes(1));
  expect(log).toHaveBeenCalledExactlyOnceWith("Request failed");
  expect(secretInput().value).toBe("test-retained-secret");
  assertSecretAbsent("test-retained-secret");
});

const checkButton = () =>
  screen.getByRole("button", {
    name: en["admin.transcription.check-connection"],
  }) as HTMLButtonElement;
const connectionRequests = () =>
  contract.fetch.mock.calls.map(([url, init]) => ({
    url,
    ...JSON.parse(init.body),
  }));

test("the real Admin transport checks only on request, with no draft or credentials, even when recognition is disabled", async () => {
  contract.enabled = false;
  render(<Harness />);
  await screen.findByText("Server activation: Disabled");
  expect(checkButton().disabled).toBe(false);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(connectionRequests().map((request) => request.operationName)).toEqual([
    "adminTranscriptionStatus",
  ]);
  fireEvent.click(checkButton());
  await screen.findByText(
    "Last connection check: Configured model listed in catalog",
  );
  const mutations = connectionRequests().filter(
    (request) => request.operationName === "adminCheckTranscriptionConnection",
  );
  expect(mutations).toHaveLength(1);
  expect(mutations[0].variables ?? {}).toEqual({});
  expect(
    connectionRequests().every((request) => request.url === "/graphql"),
  ).toBe(true);
  expect(JSON.stringify(connectionRequests())).not.toContain("operator-model");
  expect(JSON.stringify(connectionRequests())).not.toContain("REDACTED");
  expect(
    screen.getByText(en["admin.transcription.recognition-not-verified"])
      .textContent,
  ).toBe(en["admin.transcription.recognition-not-verified"]);
  expect(screen.getByText("Server activation: Disabled").textContent).toBe(
    "Server activation: Disabled",
  );
});

test("a pending pre-save status request cannot be shared with or overwrite the replacement snapshot", async () => {
  let releaseOld!: (response: Response) => void;
  contract.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        releaseOld = resolve;
      }),
  );
  render(<Harness />);
  await waitFor(() => expect(contract.fetch).toHaveBeenCalledTimes(1));
  fireEvent.change(modelInput(), { target: { value: "another-model" } });
  fireEvent.click(saveButton());
  await screen.findByText("Last connection check: Not checked");
  expect(contract.fetch).toHaveBeenCalledTimes(2);
  releaseOld(
    new Response(
      JSON.stringify({
        data: {
          admin: {
            transcriptionStatus: {
              capability: {
                enabled: true,
                configured: true,
                status: "NotChecked",
              },
              lastConnectionCheck: contract.nextCheck,
            },
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(
    screen.queryByText(
      "Last connection check: Configured model listed in catalog",
    ),
  ).toBeNull();
  expect(
    screen.getByText("Last connection check: Not checked").textContent,
  ).toBe("Last connection check: Not checked");
});
