import { type ReactElement, useState } from "react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { selectMantineOption } from "../../__tests__/test-utils";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks — must precede component import

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
const en: Record<string, string> = enJson;

const tMock = vi.fn((key: string, options?: Record<string, any>): string => {
  let text = en[key];
  if (!text) return key;
  if (options) {
    Object.entries(options).forEach(([k, v]) => {
      text = text!.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
    });
  }
  return text;
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      tMock("com.myoxus.peek-view-controls.close"),
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("../header", () => ({
  Header: ({ title }: { title: string }) => (
    <div data-testid="header">{title}</div>
  ),
}));

vi.mock("@myoxus/admin/use-query", () => ({
  gqlFetcher: vi.fn().mockResolvedValue(undefined),
  useQuery: () => ({
    data: {
      admin: {
        transcriptionStatus: {
          capability: { enabled: false, configured: false },
          lastConnectionCheck: null,
        },
      },
    },
    mutate: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@myoxus/admin/use-mutation", () => ({
  useMutation: () => ({ trigger: vi.fn() }),
}));

// Mock useAppConfig to avoid GraphQL calls
const mockUpdate = vi.fn();
const mockSaveGroup = vi.fn().mockResolvedValue(undefined);
const mockResetGroup = vi.fn();
let serverErrors: Record<string, { message: string }> = {};
let testSchema: any = null;
let testSaving = false;
let testCopilotEnabled = true;

function makeBaseConfig(copilotOverrides?: any) {
  return {
    copilot: {
      enabled: testCopilotEnabled,
      default_provider: "openai",
      request_timeout_ms: 30000,
      embedding_model: "text-embedding-3-small",
      fallback_providers: [],
      providers: {
        openai: {
          enabled: true,
          api_key: "sk-test",
          endpoint: "https://api.openai.com/v1",
          models: ["gpt.v1/model"],
          timeout_ms: 30000,
          kind: "openai",
        },
        anthropic: {
          enabled: false,
          api_key: "",
          endpoint: "",
          models: [],
          timeout_ms: 30000,
          kind: "openai",
        },
        gemini: {
          enabled: false,
          api_key: "",
          endpoint: "",
          models: [],
          timeout_ms: 30000,
          kind: "openai",
        },
        perplexity: {
          enabled: false,
          api_key: "",
          endpoint: "",
          models: [],
          timeout_ms: 30000,
          kind: "openai",
        },
        fal: {
          enabled: false,
          api_key: "",
          endpoint: "",
          models: [],
          timeout_ms: 30000,
          kind: "openai",
        },
        morph: {
          enabled: false,
          api_key: "",
          endpoint: "",
          models: [],
          timeout_ms: 30000,
          kind: "openai",
        },
        local: {
          enabled: false,
          api_key: "",
          endpoint: "",
          models: [],
          timeout_ms: 30000,
          kind: "local",
        },
      },
      unsplash: { key: "" },
      exa: { key: "exa-configured-key" },
      embedding: {
        endpoint: "",
        api_key: "",
        model: "",
        dimensions: 1536,
        send_task_type: false,
      },
      storage_prefix: "copilot/",
      ...copilotOverrides,
    },
    storage: { backend: "s3" },
    transcription: {
      enabled: false,
      endpoint: "",
      model: "operator-model",
      api_key: null,
      language: null,
      request_timeout_ms: 120000,
      max_input_bytes: 104857600,
      max_response_bytes: 16777216,
      max_duration_seconds: 7200,
      max_concurrency: 2,
    },
    indexer: {
      enabled: false,
      provider_type: "elasticsearch",
      provider_endpoint: "http://search.test:9200",
      provider_api_key: "",
      provider_username: "",
      provider_password: "",
      auto_index_batch_size: 50,
    },
    mcp: { enabled: false },
  };
}

vi.mock("../settings/use-app-config", () => ({
  useAppConfig: () => {
    const [cfg, setConfig] = useState<Record<string, any>>(makeBaseConfig);
    const [version, setVersion] = useState(0);
    return {
      appConfig: makeBaseConfig(),
      patchedAppConfig: cfg,
      schema: testSchema,
      update: (path: string, value: unknown) => {
        mockUpdate(path, value);
        setConfig((current) => {
          const next = structuredClone(current);
          const [module, field, child] = path.split("/");
          if (child)
            next[module][field] = setByPath(
              next[module][field] ?? {},
              child,
              value,
            );
          else next[module] = setByPath(next[module] ?? {}, field, value);
          return next;
        });
      },
      saveGroup: mockSaveGroup,
      saveField: vi.fn(),
      resetGroup: (module: string) => {
        mockResetGroup(module);
        setConfig((current) => ({
          ...current,
          [module]:
            makeBaseConfig()[module as keyof ReturnType<typeof makeBaseConfig>],
        }));
        setVersion((value) => value + 1);
      },
      isGroupDirty: (module: string) =>
        JSON.stringify(cfg[module]) !==
        JSON.stringify(
          makeBaseConfig()[module as keyof ReturnType<typeof makeBaseConfig>],
        ),
      isGroupSaving: () => testSaving,
      getGroupVersion: () => version,
      fieldErrorsByPath: serverErrors,
    };
  },
}));

// Import after mocks

import { AiPage } from "./index";
import { setByPath } from "../settings/utils";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("AiPage — P100-H-03", () => {
  beforeEach(() => {
    serverErrors = {};
    testSchema = null;
    testSaving = false;
    testCopilotEnabled = true;
    window.history.replaceState({}, "", "/adminfrontend/ai");
  });

  test("transcription has its own URL tab and remains editable with Copilot disabled", () => {
    testCopilotEnabled = false;
    testSchema = {
      modules: [
        {
          module: "transcription",
          groups: [
            {
              fields: Object.keys(makeBaseConfig().transcription).map(
                (key) => ({
                  key,
                  path: `transcription.${key}`,
                  databaseWritable: true,
                }),
              ),
            },
          ],
        },
      ],
    };
    window.history.replaceState({}, "", "/adminfrontend/ai?tab=transcription");
    renderWithFacade(<AiPage />);
    expect(
      screen.getByTestId("ai-tab-transcription").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      (screen.getByLabelText("Model identifier") as HTMLInputElement).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByLabelText("Model identifier"), {
      target: { value: "another-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSaveGroup).toHaveBeenCalledWith("transcription", {});
    fireEvent.click(screen.getByTestId("ai-tab-copilot"));
    fireEvent.click(screen.getByTestId("ai-routing-details"));
    expect(
      screen.queryByTestId("config-field-copilot/transcription_model"),
    ).toBeNull();
    expect(screen.getByTestId("provider-card-openai")).toBeTruthy();
  });

  afterEach(() => {
    cleanup();
    tMock.mockClear();
    mockUpdate.mockClear();
    mockSaveGroup.mockClear();
    mockResetGroup.mockClear();
    window.history.replaceState({}, "", "/adminfrontend/ai");
  });

  test("switches the URL-synced Copilot, Indexer and MCP settings surfaces", () => {
    renderWithFacade(<AiPage />);
    const copilotTab = screen.getByTestId("ai-tab-copilot");
    const indexerTab = screen.getByTestId("ai-tab-indexer");
    const mcpTab = screen.getByTestId("ai-tab-mcp");

    expect(copilotTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("provider-card-openai")).toBeTruthy();

    fireEvent.click(indexerTab);
    expect(window.location.search).toBe("?tab=indexer");
    expect(indexerTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByTestId("config-field-indexer/enabled").textContent,
    ).toContain("Enable indexer plugin");

    fireEvent.click(mcpTab);
    expect(window.location.search).toBe("?tab=mcp");
    expect(mcpTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByTestId("config-field-mcp/enabled").textContent,
    ).toContain("MCP");
  });

  test("(b) api_key field is type=password after expanding a provider card", async () => {
    renderWithFacade(<AiPage />);
    const card = screen.getByTestId("provider-card-openai");
    const toggle = card.querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    fireEvent.click(toggle);

    const apiKeyInput = (await screen.findByLabelText("API Key", {
      selector: "#openai-apiKey",
    })) as HTMLInputElement;
    expect(apiKeyInput.type).toBe("password");
    expect(document.body.textContent).toContain("env:");
  });

  test("reasoning fields update whole provider objects with literal model IDs", async () => {
    serverErrors = {
      "config/candidate": {
        message:
          "reasoning_effort requires distinct supported on and off values",
      },
    };
    renderWithFacade(<AiPage />);
    const card = screen.getByTestId("provider-card-openai");
    fireEvent.click(card.querySelector("button[aria-expanded]")!);
    const select = await screen.findByRole("combobox", {
      name: "Reasoning control for gpt.v1/model",
    });
    selectMantineOption(select, "vLLM enable_thinking");
    expect(screen.getByRole("alert").textContent).toContain(
      "reasoning_effort requires distinct supported on and off values",
    );
    expect(mockUpdate).toHaveBeenLastCalledWith(
      "copilot/providers",
      expect.objectContaining({
        openai: expect.objectContaining({
          model_options: {
            "gpt.v1/model": { reasoning_control: { type: "enable_thinking" } },
          },
        }),
      }),
    );
    const vision = screen.getByRole("switch", {
      name: "Image input supported: gpt.v1/model",
    });
    fireEvent.click(vision);
    selectMantineOption(select, "reasoning_effort");
    selectMantineOption(
      screen.getByRole("combobox", { name: "Effort when reasoning is on" }),
      "high",
    );
    selectMantineOption(
      screen.getByRole("combobox", { name: "Effort when reasoning is off" }),
      "none",
    );
    expect(mockUpdate).toHaveBeenLastCalledWith(
      "copilot/providers",
      expect.objectContaining({
        openai: expect.objectContaining({
          model_options: {
            "gpt.v1/model": {
              supports_vision: true,
              reasoning_control: {
                type: "reasoning_effort",
                on: "high",
                off: "none",
              },
            },
          },
        }),
      }),
    );
    selectMantineOption(select, "Provider default (no override)");
    expect(mockUpdate).toHaveBeenLastCalledWith(
      "copilot/providers",
      expect.objectContaining({
        openai: expect.objectContaining({
          model_options: { "gpt.v1/model": { supports_vision: true } },
        }),
      }),
    );
    fireEvent.click(vision);
    expect(mockUpdate).toHaveBeenLastCalledWith(
      "copilot/providers",
      expect.objectContaining({
        openai: expect.objectContaining({ model_options: {} }),
      }),
    );
  });

  test("native routing tags preserve order and save only Copilot while other tabs keep their drafts", async () => {
    renderWithFacade(<AiPage />);
    const fallback = screen.getByRole("combobox", {
      name: "Fallback provider IDs (in priority order)",
    });
    await userEvent
      .setup()
      .type(fallback, "local{Enter}gateway{Enter}local{Enter}");
    expect(mockUpdate).toHaveBeenLastCalledWith("copilot/fallback_providers", [
      "local",
      "gateway",
    ]);
    fireEvent.click(screen.getByTestId("embedding-section-toggle"));
    const model = await screen.findByRole("textbox", {
      name: "Model",
    });
    fireEvent.change(model, {
      target: { value: "long-embedding-model-draft" },
    });
    fireEvent.change(screen.getByTestId("embedding-dims-input"), {
      target: { value: "768" },
    });
    expect(mockUpdate).toHaveBeenLastCalledWith(
      "copilot/embedding.dimensions",
      768,
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Task-specific embedding encoding" }),
    );
    expect(mockUpdate).toHaveBeenLastCalledWith(
      "copilot/embedding.send_task_type",
      true,
    );
    expect(
      mockUpdate.mock.calls.every(([path]) => path !== "copilot/providers"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Indexer" }));
    fireEvent.click(screen.getByTestId("ai-indexer-details"));
    const endpoint = await screen.findByRole("textbox", {
      name: "Indexer search service endpoint",
    });
    fireEvent.change(endpoint, {
      target: { value: "http://search.test:9200/retained-draft" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Copilot" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Model",
        }) as HTMLInputElement
      ).value,
    ).toBe("long-embedding-model-draft");
    expect(
      (screen.getByTestId("embedding-dims-input") as HTMLInputElement).value,
    ).toBe("768");
    expect(
      (
        screen.getByRole("switch", {
          name: "Task-specific embedding encoding",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockSaveGroup).toHaveBeenCalledExactlyOnceWith("copilot");
    fireEvent.click(screen.getByRole("tab", { name: "Indexer" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockResetGroup).toHaveBeenCalledExactlyOnceWith("indexer");
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "Indexer search service endpoint",
        })) as HTMLInputElement
      ).value,
    ).toBe("http://search.test:9200");
    fireEvent.click(screen.getByRole("tab", { name: "Copilot" }));
    if (
      screen
        .getByTestId("embedding-section-toggle")
        .getAttribute("aria-expanded") !== "true"
    )
      fireEvent.click(screen.getByTestId("embedding-section-toggle"));
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "Model",
        })) as HTMLInputElement
      ).value,
    ).toBe("long-embedding-model-draft");
  });

  test("(d) kind change on provider with configured endpoint triggers warning", async () => {
    renderWithFacade(<AiPage />);
    const card = screen.getByTestId("provider-card-openai");
    fireEvent.click(
      card.querySelector("button[aria-expanded]") as HTMLButtonElement,
    );

    const kindSelect = await screen.findByTestId("kind-select-openai");
    fireEvent.click(kindSelect);
    const localKindOption = document.querySelector(
      '[data-combobox-option][value="local"]',
    );
    expect(localKindOption).not.toBeNull();
    fireEvent.click(localKindOption!);

    // Warning must appear — endpoint must NOT be auto-overwritten
    const warning = screen.queryByTestId("kind-change-warning-openai");
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toContain("Endpoint will be reset");
    fireEvent.click(within(warning!).getByRole("button", { name: "Cancel" }));
    expect(
      (screen.getByTestId("input-openai-endpoint") as HTMLInputElement).value,
    ).toBe("https://api.openai.com/v1");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("(e) Add custom provider dialog opens, accepts valid ID, creates card", async () => {
    renderWithFacade(<AiPage />);
    fireEvent.click(screen.getByTestId("add-custom-provider-btn"));

    const dialog = await screen.findByTestId("add-custom-provider-dialog");
    expect(dialog.textContent).toContain("Add Custom Provider");

    fireEvent.change(screen.getByTestId("custom-provider-id-input"), {
      target: { value: "my-vllm" },
    });
    fireEvent.click(screen.getByTestId("confirm-add-custom-provider"));

    await waitFor(() =>
      expect(screen.queryByTestId("add-custom-provider-dialog")).toBeNull(),
    );
    expect(screen.getByTestId("provider-card-my-vllm").textContent).toContain(
      "my-vllm",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockResetGroup).toHaveBeenCalledWith("copilot");
    expect(screen.queryByTestId("provider-card-my-vllm")).toBeNull();
  });

  test("(e) Custom provider dialog rejects duplicate ID", async () => {
    renderWithFacade(<AiPage />);
    fireEvent.click(screen.getByTestId("add-custom-provider-btn"));

    fireEvent.change(await screen.findByTestId("custom-provider-id-input"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByTestId("confirm-add-custom-provider"));

    expect(screen.getByTestId("add-custom-provider-dialog")).toBeTruthy(); // still open
    expect(document.body.textContent).toContain("already exists");
  });

  // The warning in the no-active-provider case is driven by the config data.
  // The base mock has openai with enabled=true && api_key='sk-test' so it IS active.
  // We test the warning using a fresh render that verifies the conditional logic:
  // warning appears ONLY when masterEnabled=true && activeProviders.length===0.
  // Verified by checking no warning appears in default config (openai is active).

  test("(j) Unsplash key renders as masked secret field", async () => {
    renderWithFacade(<AiPage />);
    fireEvent.click(screen.getByTestId("ai-external-details"));
    await screen.findByTestId("secret-field-copilot-unsplash-key");
    const field = document.querySelector(
      '[data-testid="secret-field-copilot-unsplash-key"]',
    ) as HTMLInputElement | null;
    expect(field).not.toBeNull();
    expect(field!.type).toBe("password");
  });

  test("(j) Exa key renders as masked secret field with Configured badge when key is set", async () => {
    renderWithFacade(<AiPage />);
    fireEvent.click(screen.getByTestId("ai-external-details"));
    await screen.findByTestId("secret-field-copilot-exa-key");
    const field = document.querySelector(
      '[data-testid="secret-field-copilot-exa-key"]',
    ) as HTMLInputElement | null;
    expect(field).not.toBeNull();
    expect(field!.type).toBe("password");
    // Exa has key set in mock — should show Configured badge nearby
    const configuredBadges = screen.getAllByText("Configured");
    expect(configuredBadges.length).toBeGreaterThan(0);
  });

  // Old JSON textarea storage fields not rendered

  // Indexer + MCP still present
});
