import type { ReactElement } from "react";
// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";

import { SWRConfig } from "swr";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SecurityPage } from "./index";

function renderWithFacade(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <MyoxusUIProvider>{ui}</MyoxusUIProvider>
    </SWRConfig>,
  );
}

const tlsSnapshot = {
  source: "ENVIRONMENT",
  source_key: "MYOXUS__TLS__ADDITIONAL_CA_BUNDLE_PATH",
  additional_ca_count: 2,
  legacy_git_ca_count: 0,
  snapshot_id: "loaded-snapshot",
  legacy: false,
};
const tlsFetchMock = vi.fn().mockResolvedValue(tlsSnapshot);
vi.mock("../../api/runtime-status-api", () => ({
  fetchGlobalTlsSnapshot: () => tlsFetchMock(),
}));

const updateMock = vi.fn();
const saveGroupMock = vi.fn().mockResolvedValue(undefined);
const resetGroupMock = vi.fn();
const mutateMock = vi.fn().mockResolvedValue(undefined);
const oauthMutationMock = vi.fn().mockResolvedValue({});
const oidcTestMutationMock = vi.fn().mockResolvedValue({
  admin: {
    testOidcProvider: {
      discoveryOk: true,
      jwksOk: true,
      issuer: "https://issuer.example.com",
      authorizationEndpointPresent: true,
      tokenEndpointPresent: true,
      userinfoEndpointPresent: true,
      jwksKeyCount: 2,
      groupsClaimPresent: true,
      groupsCount: 2,
      mappedGroupsCount: 1,
      unknownGroupsCount: 1,
      warnings: [],
    },
  },
});
const legacyOidcConfig = {
  clientId: "oidc-client",
  clientSecret: "oidc-secret",
  issuerUrl: "https://issuer.example.com",
  authUrl: "https://issuer.example.com/auth",
  tokenUrl: "https://issuer.example.com/token",
  userinfoUrl: "https://issuer.example.com/userinfo",
  scopes: "openid profile email",
  userIdField: "sub",
  userEmailField: "email",
  userNameField: "name",
  userAvatarField: "picture",
};
let savedOidc: Record<string, unknown> | undefined;
const directoryConfigSnapshot = () => ({
  modules: savedOidc
    ? [
        {
          module: "oauth",
          groups: [
            { fields: [{ path: "oauth.providers.oidc", value: savedOidc }] },
          ],
        },
      ]
    : [],
});
const configFetcherMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  (..._args: unknown[]) =>
    Promise.resolve({
      admin: { adminConfigValues: directoryConfigSnapshot() },
    }),
);
const organizationUnitsMock = vi.fn((..._args: unknown[]) => ({
  data: {
    admin: {
      organizationUnits: [] as Array<{
        id: string;
        name: string;
        slug: string;
        parentUnitId: string | null;
        status: string;
      }>,
    },
  },
}));

function clickProviderAccordion(label: string) {
  const trigger = screen.getByText(label).closest("button");
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
}

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () => "Close",
    t: (key: string, vars?: Record<string, string>) =>
      vars?.provider ? `${key}:${vars.provider}` : key,
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    notify: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock("../../use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) =>
    mutation.id === "adminTestOidcProviderMutation"
      ? { trigger: oidcTestMutationMock, isMutating: false }
      : { trigger: oauthMutationMock, isMutating: false },
}));

vi.mock("../../use-query", () => ({
  gqlFetcher: (...args: unknown[]) => configFetcherMock(...args),
  useQuery: (options?: { query: { id: string }; variables?: unknown }) =>
    options?.query.id === "adminOrganizationUnitsQuery"
      ? organizationUnitsMock(options)
      : {
          data: {
            admin: {
              adminConfigValues: {
                ...directoryConfigSnapshot(),
                effectiveFields: [
                  {
                    path: "tls.additional_ca_bundle_path",
                    runtimeEffectiveValue: "ca/company.pem",
                  },
                ],
                oauth: {
                  providers: {
                    google: { clientId: "gid", clientSecret: "secret" },
                    github: null,
                    oidc: legacyOidcConfig,
                    apple: null,
                  },
                },
              },
            },
          },
          mutate: mutateMock,
        },
}));

vi.mock("../common", () => ({
  useRevalidateServerConfig: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../header", () => ({
  Header: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock("../operational-readiness-notice", () => ({
  OperationalReadinessNotice: () => null,
}));

vi.mock("../settings/use-app-config", () => ({
  useAppConfig: () => ({
    appConfig: {
      auth: {
        allowSignup: true,
        allowSignupForOauth: true,
        requireEmailVerification: false,
        requireEmailDomainVerification: false,
        passwordRequirements: { min: 8, max: 64 },
        rejectPlusAliases: false,
        allowedEmailDomains: [],
        dnsTimeoutSeconds: 5,
        passwordResetTtlSeconds: 1800,
      },
      cors: {
        allowedOrigins: ["https://example.test"],
        appOrigins: [],
        allowedCustomHeaders: ["x-test"],
        maxAgeSeconds: 3600,
      },
      captcha: {
        enabled: true,
        algorithm: "SHA-256",
        hmacKey: "",
        challengeExpiresSeconds: 300,
        maxNumber: 100000,
        rateLimitPerIpPerMin: 10,
        rateLimitPerAccountPerHour: 50,
        honeypotFieldName: "website",
      },
      oauth: {
        providers: {
          google: { clientId: "gid", clientSecret: "secret" },
          github: null,
          oidc: legacyOidcConfig,
          apple: null,
        },
      },
    },
    patchedAppConfig: {},
    schema: {},
    update: updateMock,
    saveGroup: saveGroupMock,
    resetGroup: resetGroupMock,
    isGroupDirty: () => false,
    isGroupSaving: () => false,
    getGroupVersion: () => 0,
    fieldErrorsByPath: {},
  }),
}));

describe("SecurityPage", () => {
  afterEach(() => {
    cleanup();
    oauthMutationMock.mockClear();
    oidcTestMutationMock.mockClear();
    vi.unstubAllGlobals();
    tlsFetchMock.mockReset().mockResolvedValue(tlsSnapshot);
    window.history.replaceState({}, "", "/adminfrontend/security");
    savedOidc = undefined;
    configFetcherMock
      .mockReset()
      .mockImplementation(() =>
        Promise.resolve({
          admin: { adminConfigValues: directoryConfigSnapshot() },
        }),
      );
    oauthMutationMock.mockReset().mockResolvedValue({});
    organizationUnitsMock
      .mockReset()
      .mockReturnValue({ data: { admin: { organizationUnits: [] } } });
  });

  test("resolves persisted OU ancestry including inactive targets without dropping missing rules", async () => {
    organizationUnitsMock.mockReturnValue({
      data: {
        admin: {
          organizationUnits: [
            {
              id: "root",
              name: "Organization",
              slug: "organization",
              parentUnitId: null,
              status: "Active",
            },
            {
              id: "branch",
              name: "Branch",
              slug: "branch",
              parentUnitId: "root",
              status: "Active",
            },
            {
              id: "first",
              name: "Operations",
              slug: "first",
              parentUnitId: "root",
              status: "Inactive",
            },
            {
              id: "second",
              name: "Operations",
              slug: "second",
              parentUnitId: "branch",
              status: "Active",
            },
            {
              id: "sibling",
              name: "Operations",
              slug: "sibling",
              parentUnitId: "root",
              status: "Active",
            },
          ],
        },
      },
    });
    const mappings = ["first", "second", "sibling", "missing"].map(
      (targetUnitId) => ({ providerGroup: targetUnitId, targetUnitId }),
    );
    savedOidc = { ...legacyOidcConfig, groupMapping: { mappings } };
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);
    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "admin.security.oauth.group-mapping",
      }),
    );
    expect(
      await screen.findByDisplayValue("Organization / Operations · first"),
    ).toBeTruthy();
    expect(
      screen.getByDisplayValue("Organization / Branch / Operations"),
    ).toBeTruthy();
    expect(
      screen.getByDisplayValue("Organization / Operations · sibling"),
    ).toBeTruthy();
    expect(
      screen.getByDisplayValue(
        "com.myoxus.reference.target-unavailable (missing)",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "com.myoxus.reference.target-unavailable",
    );
    expect(organizationUnitsMock).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { status: null } }),
    );
    fireEvent.click(screen.getByTestId("security-oauth-save-oidc"));
    await waitFor(() =>
      expect(oauthMutationMock).toHaveBeenCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.oidc",
            value: expect.objectContaining({
              groupMapping: expect.objectContaining({ mappings }),
            }),
          },
        ],
      }),
    );
  });

  test("keeps simple and OIDC drafts through native tab and disclosure reactivation", async () => {
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);
    clickProviderAccordion("admin.security.oauth.google");
    const googleInput = () =>
      document.getElementById("google-client-id") as HTMLInputElement;
    await waitFor(() => expect(googleInput()).not.toBeNull());
    fireEvent.change(googleInput(), { target: { value: "unsaved-google-id" } });
    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    const issuerInput = () =>
      screen.getByLabelText(
        "admin.security.oauth.issuer-url",
      ) as HTMLInputElement;
    await screen.findByLabelText("admin.security.oauth.issuer-url");
    fireEvent.change(issuerInput(), {
      target: { value: "https://unsaved.example.test" },
    });
    fireEvent.click(screen.getByTestId("security-tab-trigger-cors"));
    fireEvent.click(screen.getByTestId("security-tab-trigger-oauth"));
    await waitFor(() => expect(googleInput().value).toBe("unsaved-google-id"));
    expect(issuerInput().value).toBe("https://unsaved.example.test");
    clickProviderAccordion("admin.security.oauth.google");
    clickProviderAccordion("admin.security.oauth.google");
    await waitFor(() => expect(googleInput().value).toBe("unsaved-google-id"));
    expect(oauthMutationMock).not.toHaveBeenCalled();
  });

  test("directory-only save preserves saved rules and independent mapping/login drafts", async () => {
    const rules = {
      enabled: true,
      defaultRole: "reader",
      removeMissingOidcMemberships: false,
      missingGroupsPolicy: "allow_without_memberships",
      unknownGroups: "deny_login",
      mappings: [{ providerGroup: "SavedGroup", targetUnitId: "saved-ou" }],
    };
    savedOidc = {
      ...legacyOidcConfig,
      groupMapping: rules,
      groupDirectory: {
        type: "authentik",
        baseUrl: "https://saved.example.test",
        token: "***REDACTED***",
      },
    };
    oauthMutationMock.mockImplementation(async ({ updates }) => {
      const value = updates[0].value;
      savedOidc = {
        ...value,
        groupDirectory: value.groupDirectory
          ? { ...value.groupDirectory, token: "***REDACTED***" }
          : null,
      };
      return {
        admin: {
          adminUpdateConfig: {
            applied: true,
            fieldErrors: [],
            config: directoryConfigSnapshot(),
          },
        },
      };
    });
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);
    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    fireEvent.change(
      await screen.findByLabelText("admin.security.oauth.issuer-url"),
      { target: { value: "https://unsaved-login.example.test" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "admin.security.oauth.group-mapping",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "admin.security.oauth.directory-manual",
      }),
    );
    fireEvent.change(await screen.findByPlaceholderText("finance/managers"), {
      target: { value: "UnsavedGroup" },
    });
    const connection = within(screen.getByTestId("oidc-group-directory"));
    fireEvent.change(
      connection.getByLabelText("admin.system.overview.base-url"),
      { target: { value: "https://replacement.example.test/prefix" } },
    );
    fireEvent.change(
      connection.getByLabelText("admin.security.oauth.directory-token"),
      { target: { value: "new-directory-secret" } },
    );
    fireEvent.click(connection.getByTestId("oidc-directory-save"));
    await waitFor(() =>
      expect(oauthMutationMock).toHaveBeenCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.oidc",
            value: expect.objectContaining({
              issuerUrl: legacyOidcConfig.issuerUrl,
              groupMapping: rules,
              groupDirectory: {
                type: "authentik",
                baseUrl: "https://replacement.example.test/prefix",
                token: "new-directory-secret",
              },
            }),
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(
        (
          connection.getByLabelText(
            "admin.security.oauth.directory-token",
          ) as HTMLInputElement
        ).value,
      ).toBe(""),
    );
    expect(
      (screen.getByPlaceholderText("finance/managers") as HTMLInputElement)
        .value,
    ).toBe("UnsavedGroup");
    expect(
      (
        screen.getByLabelText(
          "admin.security.oauth.issuer-url",
        ) as HTMLInputElement
      ).value,
    ).toBe("https://unsaved-login.example.test");
    fireEvent.click(screen.getByTestId("security-tab-trigger-cors"));
    fireEvent.click(screen.getByTestId("security-tab-trigger-oauth"));
    expect(
      (screen.getByPlaceholderText("finance/managers") as HTMLInputElement)
        .value,
    ).toBe("UnsavedGroup");
    fireEvent.click(
      connection.getByRole("button", { name: "admin.security.oauth.remove" }),
    );
    fireEvent.click(connection.getByTestId("oidc-directory-save"));
    await waitFor(() =>
      expect(oauthMutationMock).toHaveBeenLastCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.oidc",
            value: expect.objectContaining({
              issuerUrl: legacyOidcConfig.issuerUrl,
              groupMapping: rules,
              groupDirectory: null,
            }),
          },
        ],
      }),
    );
  });

  test("catalog search commits only selectable claims and retains manual values across empty or failed refreshes", async () => {
    savedOidc = {
      ...legacyOidcConfig,
      groupDirectory: {
        type: "authentik",
        baseUrl: "https://directory.example.test",
        token: "***REDACTED***",
      },
      groupMapping: {
        mappings: [
          { providerGroup: "RetainedUnknown", targetUnitId: "saved-ou" },
        ],
      },
    };
    const entries = [
      {
        id: "ambiguous-a",
        displayName: "Branch A",
        path: "/A",
        claimValue: "Branch",
        state: "AMBIGUOUS",
      },
      {
        id: "ambiguous-b",
        displayName: "Branch B",
        path: "/B",
        claimValue: "Branch",
        state: "AMBIGUOUS",
      },
      {
        id: "provider-id-not-a-claim",
        displayName: "Branch Finance",
        path: "/Finance",
        claimValue: "Claim/Finance",
        state: "AVAILABLE",
      },
    ];
    configFetcherMock
      .mockResolvedValueOnce({ admin: { oidcGroupDirectory: { entries } } })
      .mockResolvedValueOnce({ admin: { oidcGroupDirectory: { entries: [] } } })
      .mockRejectedValueOnce(
        new Error("OIDC_GROUP_DIRECTORY_ACCESS_DENIED: HTTP 403"),
      );
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);
    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "admin.security.oauth.group-mapping",
      }),
    );
    const group = await screen.findByPlaceholderText("finance/managers");
    fireEvent.click(screen.getByTestId("oidc-directory-load"));
    await screen.findByText("admin.security.oauth.directory-loaded");
    fireEvent.focus(group);
    fireEvent.change(group, { target: { value: "Branch" } });
    expect(
      (await screen.findByText("Branch A"))
        .closest("[role=option]")
        ?.getAttribute("data-combobox-disabled"),
    ).toBe("true");
    fireEvent.keyDown(group, { key: "Escape" });
    expect((group as HTMLInputElement).value).toBe("RetainedUnknown");
    fireEvent.focus(group);
    fireEvent.change(group, { target: { value: "Branch" } });
    fireEvent.keyDown(group, { key: "ArrowDown" });
    fireEvent.keyDown(group, { key: "Enter" });
    expect((group as HTMLInputElement).value).toBe("Claim/Finance");
    expect(configFetcherMock).toHaveBeenCalledTimes(1);
    expect(oauthMutationMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("oidc-directory-load"));
    await screen.findAllByText("admin.security.oauth.directory-empty");
    expect((group as HTMLInputElement).value).toBe("Claim/Finance");
    fireEvent.click(screen.getByTestId("oidc-directory-load"));
    expect(
      await screen.findAllByText(
        "OIDC_GROUP_DIRECTORY_ACCESS_DENIED: HTTP 403",
      ),
    ).not.toHaveLength(0);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "admin.security.oauth.directory-manual",
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("finance/managers"), {
      target: { value: "TransformedClaim" },
    });
    fireEvent.click(screen.getByTestId("security-oauth-save-oidc"));
    await waitFor(() =>
      expect(oauthMutationMock).toHaveBeenCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.oidc",
            value: expect.objectContaining({
              groupMapping: expect.objectContaining({
                mappings: [
                  {
                    providerGroup: "TransformedClaim",
                    targetUnitId: "saved-ou",
                    role: undefined,
                  },
                ],
              }),
            }),
          },
        ],
      }),
    );
  });

  test("connection edits retire an owned catalog request and fresh loads cannot join or publish its late response", async () => {
    savedOidc = {
      ...legacyOidcConfig,
      groupDirectory: {
        type: "authentik",
        baseUrl: "https://directory.example.test",
        token: "***REDACTED***",
      },
      groupMapping: {
        mappings: [
          { providerGroup: "RetainedUnknown", targetUnitId: "saved-ou" },
        ],
      },
    };
    let resolveOld!: (value: unknown) => void;
    configFetcherMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        admin: {
          oidcGroupDirectory: {
            entries: [
              {
                id: "new",
                displayName: "Current group",
                claimValue: "Current",
                path: null,
                state: "AVAILABLE",
              },
            ],
          },
        },
      });
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);
    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "admin.security.oauth.group-mapping",
      }),
    );
    fireEvent.click(await screen.findByTestId("oidc-directory-load"));
    const first = configFetcherMock.mock.calls[0][0] as { signal: AbortSignal };
    const connection = within(screen.getByTestId("oidc-group-directory"));
    fireEvent.change(
      connection.getByLabelText("admin.system.overview.base-url"),
      { target: { value: "https://changed.example.test" } },
    );
    await waitFor(() => expect(first.signal.aborted).toBe(true));
    expect(
      (screen.getByTestId("oidc-directory-load") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      connection.getByRole("button", { name: "admin.common.discard" }),
    );
    fireEvent.click(screen.getByTestId("oidc-directory-load"));
    await screen.findByText("admin.security.oauth.directory-loaded");
    await act(async () => {
      resolveOld({
        admin: {
          oidcGroupDirectory: {
            entries: [
              {
                id: "old",
                displayName: "Retired group",
                claimValue: "Old",
                path: null,
                state: "AVAILABLE",
              },
            ],
          },
        },
      });
    });
    fireEvent.focus(screen.getByPlaceholderText("finance/managers"));
    expect(
      (await screen.findByText("Current group")).closest("[role=option]"),
    ).toBeTruthy();
    expect(screen.queryByText("Retired group")).toBeNull();
    expect(configFetcherMock).toHaveBeenCalledTimes(2);
    const second = configFetcherMock.mock.calls[1][0] as {
      signal: AbortSignal;
    };
    expect(second.signal).not.toBe(first.signal);
    fireEvent.keyDown(screen.getByPlaceholderText("finance/managers"), {
      key: "Escape",
    });
    expect(
      (screen.getByPlaceholderText("finance/managers") as HTMLInputElement)
        .value,
    ).toBe("RetainedUnknown");
    expect(oauthMutationMock).not.toHaveBeenCalled();
  });

  test("distinguishes legacy Git-only trust from global roots", async () => {
    tlsFetchMock.mockResolvedValue({
      ...tlsSnapshot,
      legacy: true,
      additional_ca_count: 0,
      legacy_git_ca_count: 1,
    });
    renderWithFacade(<SecurityPage />);
    const section = within(screen.getByTestId("global-tls"));
    expect(await section.findByText("admin.security.tls.legacy")).toBeTruthy();
    expect(section.getByText("0")).toBeTruthy();
    expect(section.getByText("1")).toBeTruthy();
  });

  test("does not claim an active snapshot when TLS status fails", async () => {
    tlsFetchMock.mockRejectedValue(new Error("unavailable"));
    renderWithFacade(<SecurityPage />);
    const section = within(screen.getByTestId("global-tls"));
    expect(
      (await section.findByText("admin.security.tls.unavailable")).getAttribute(
        "role",
      ),
    ).toBe("alert");
    expect(section.queryByText("loaded-snapshot")).toBeNull();
  });

  test("keeps loading explicit instead of reporting zero roots", () => {
    tlsFetchMock.mockReturnValue(new Promise(() => {}));
    renderWithFacade(<SecurityPage />);
    const section = within(screen.getByTestId("global-tls"));
    expect(section.getByText("admin.common.loading")).toBeTruthy();
    expect(section.queryByText("0")).toBeNull();
  });

  test("oauth tab saves provider config through oauth module", async () => {
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);

    clickProviderAccordion("admin.security.oauth.google");
    fireEvent.click(await screen.findByTestId("security-oauth-save-google"));

    await waitFor(() => {
      expect(oauthMutationMock).toHaveBeenCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.google",
            value: { clientId: "gid", clientSecret: "secret" },
          },
        ],
      });
    });
  });

  test("oidc provider saves the server-validated config contract", async () => {
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);

    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "admin.security.oauth.group-mapping",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "admin.security.oauth.add-mapping",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "admin.security.oauth.directory-manual",
      }),
    );
    const group = await screen.findByPlaceholderText("finance/managers");
    group.focus();
    fireEvent.change(group, { target: { value: "Finance" } });
    expect(screen.getByPlaceholderText("finance/managers")).toBe(group);
    expect(document.activeElement).toBe(group);
    fireEvent.click(screen.getByTestId("security-oauth-save-oidc"));
    expect(
      await screen.findByText("admin.security.oauth.mapping-unit-required"),
    ).toBeTruthy();
    expect(oauthMutationMock).not.toHaveBeenCalled();
    expect((group as HTMLInputElement).value).toBe("Finance");
    fireEvent.click(
      screen.getByRole("button", {
        name: "admin.security.oauth.remove-mapping",
      }),
    );

    fireEvent.click(await screen.findByTestId("security-oauth-save-oidc"));

    await waitFor(() => {
      expect(oauthMutationMock).toHaveBeenCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.oidc",
            value: expect.objectContaining({
              clientId: "oidc-client",
              clientSecret: "oidc-secret",
              issuerUrl: "https://issuer.example.com",
              scopes: ["openid", "profile", "email"],
              claims: expect.objectContaining({
                subject: "sub",
                email: "email",
                emailVerified: "email_verified",
                groups: "groups",
                groupsSource: "userinfo",
              }),
              groupMapping: expect.objectContaining({
                enabled: false,
                defaultRole: "member",
                removeMissingOidcMemberships: true,
                missingGroupsPolicy: "deny_login",
                unknownGroups: "ignore",
                mappings: [],
              }),
            }),
          },
        ],
      });
    });
  });

  test("oidc provider diagnostics call the server-backed test action", async () => {
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);

    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    fireEvent.change(
      await screen.findByLabelText(
        "admin.security.oauth.oidc-test-sample-claims",
      ),
      {
        target: { value: '{"groups":["finance","unknown"]}' },
      },
    );
    fireEvent.click(screen.getByText("admin.security.oauth.oidc-test"));

    await waitFor(() => {
      expect(oidcTestMutationMock).toHaveBeenCalledWith({
        config: expect.objectContaining({
          clientId: "oidc-client",
          clientSecret: "oidc-secret",
          scopes: ["openid", "profile", "email"],
          claims: expect.objectContaining({
            groups: "groups",
            groupsSource: "userinfo",
          }),
        }),
        sampleClaims: { groups: ["finance", "unknown"] },
      });
    });
    expect(
      screen.getByText("admin.security.oauth.oidc-test-result"),
    ).toBeTruthy();
  });

  test("oidc provider preset derives Authentik endpoints before saving", async () => {
    window.history.replaceState({}, "", "/adminfrontend/security?tab=oauth");
    renderWithFacade(<SecurityPage />);

    fireEvent.click(screen.getByTestId("security-oauth-provider-oidc"));
    fireEvent.change(
      await screen.findByLabelText("admin.security.oauth.issuer-url"),
      {
        target: {
          value: "https://auth.example.test/application/o/myoxus/",
        },
      },
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: "admin.security.oauth.preset-authentik",
      }),
    );
    fireEvent.click(screen.getByText("admin.security.oauth.apply-preset"));
    fireEvent.click(screen.getByTestId("security-oauth-save-oidc"));

    await waitFor(() => {
      expect(oauthMutationMock).toHaveBeenCalledWith({
        updates: [
          {
            module: "oauth",
            key: "providers.oidc",
            value: expect.objectContaining({
              issuerUrl: "https://auth.example.test/application/o/myoxus/",
              discoveryUrl:
                "https://auth.example.test/application/o/myoxus/.well-known/openid-configuration",
              authUrl:
                "https://auth.example.test/application/o/myoxus/authorize/",
              tokenUrl: "https://auth.example.test/application/o/myoxus/token/",
              userinfoUrl:
                "https://auth.example.test/application/o/myoxus/userinfo/",
              jwksUrl: "https://auth.example.test/application/o/myoxus/jwks/",
              claims: expect.objectContaining({ groupsSource: "both" }),
              groupMapping: expect.objectContaining({
                defaultRole: "member",
              }),
            }),
          },
        ],
      });
    });
  });

  test("captcha tab includes operator challenge test", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ challenge: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/adminfrontend/security?tab=captcha");
    const { container } = renderWithFacade(<SecurityPage />);

    expect(container.querySelector(".admin-ui-control-tight")).toBeNull();
    expect(container.querySelector(".org-body")).toBeNull();
    expect(screen.getByText("admin.security.captcha.test-idle")).toBeTruthy();

    fireEvent.click(screen.getByText("admin.security.captcha.test-button"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/challenge",
        expect.objectContaining({
          credentials: "include",
          headers: expect.any(Headers),
        }),
      );
    });
  });
});
