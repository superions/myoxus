// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mutateMock = vi.fn();
const fetchConfigMock = vi.fn();

const I18N: Record<string, string> = {
  "admin.configWizard.authMethod.title": "Authentication method",
  "admin.configWizard.authMethod.description": "Choose how admins sign in.",
  "admin.configWizard.authMethod.magicLink": "Email magic link",
  "admin.configWizard.authMethod.magicLinkDesc": "Use the shared email login.",
  "admin.configWizard.authMethod.google": "Google",
  "admin.configWizard.authMethod.googleDesc": "Configure Google OAuth.",
  "admin.configWizard.authMethod.github": "GitHub",
  "admin.configWizard.authMethod.githubDesc": "Configure GitHub OAuth.",
  "admin.configWizard.authMethod.oidc": "OIDC / Custom",
  "admin.configWizard.authMethod.oidcDesc": "Configure a custom OIDC provider.",
  "admin.configWizard.authMethod.clientId": "Client ID",
  "admin.configWizard.authMethod.clientSecret": "Client Secret",
  "admin.configWizard.authMethod.discoveryPlaceholder":
    "https://auth.example.com/.well-known/openid-configuration",
  "admin.configWizard.authMethod.discoveryUrl": "Discovery URL",
  "admin.configWizard.authMethod.authUrl": "Authorization URL",
  "admin.configWizard.authMethod.issuerUrl": "Issuer URL",
  "admin.configWizard.authMethod.jwksUrl": "JWKS URL",
  "admin.configWizard.authMethod.scopes": "Scopes",
  "admin.configWizard.authMethod.tokenUrl": "Token URL",
  "admin.configWizard.authMethod.userinfoUrl": "Userinfo URL",
  "admin.configWizard.authMethod.oidcHint": "Use OIDC discovery endpoints.",
  "admin.configWizard.authMethod.endpointPlaceholder":
    "https://auth.example.com/...",
  "admin.configWizard.authMethod.groupMappingEnabled":
    "Set up OIDC group mapping during setup",
  "admin.configWizard.authMethod.groupMappingEmpty":
    "Add mappings only if matching organization units already exist.",
  "admin.security.oauth.add-mapping": "Add mapping",
  "admin.security.oauth.apply-preset": "Apply preset endpoints",
  "admin.security.oauth.default-role": "Default role",
  "admin.security.oauth.preset": "Provider preset",
  "admin.security.oauth.preset-authentik": "Authentik",
  "admin.security.oauth.preset-custom": "Custom",
  "admin.security.oauth.preset-keycloak": "Keycloak",
  "admin.security.oauth.provider-group": "Provider group",
  "admin.security.oauth.remove-mapping": "Remove mapping",
  "admin.security.oauth.role": "Role",
  "admin.security.oauth.role-manager": "Manager",
  "admin.security.oauth.role-member": "Member",
  "admin.security.oauth.role-reader": "Reader",
  "admin.security.oauth.target-ou": "Target organization unit",
  "admin.security.oauth.target-ou-placeholder": "Search organization unit",
  "admin.common.actions": "Actions",
  "common.continue": "Continue",
  "common.saving": "Saving…",
  "common.show": "Show",
  "common.hide": "Hide",
};

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => I18N[key] ?? key,
  }),
}));

vi.mock("../../../hooks/use-admin-update-config", () => ({
  useAdminUpdateConfig: () => ({
    mutate: mutateMock,
    isLoading: false,
  }),
}));

vi.mock("../../../use-query", () => ({
  gqlFetcher: (...args: unknown[]) => fetchConfigMock(...args),
}));

vi.mock("../../../components/domain-pickers/ou-picker", () => ({
  OuPicker: ({
    onChange,
    placeholder,
    value,
  }: {
    onChange: (value: string | null) => void;
    placeholder?: string;
    value?: string | null;
  }) => (
    <input
      aria-label={placeholder}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

import { AuthMethodStep } from "./auth-method";

function renderAuthMethodStep(onNext = vi.fn()) {
  const view = render(
    <MyoxusUIProvider>
      <AuthMethodStep onNext={onNext} />
    </MyoxusUIProvider>,
  );
  return { ...view, onNext };
}

describe("AuthMethodStep", () => {
  beforeEach(() => {
    mutateMock.mockReset();
    mutateMock.mockResolvedValue({ applied: [] });
    fetchConfigMock.mockReset();
    fetchConfigMock.mockResolvedValue({
      admin: { adminConfigValues: { modules: [] } },
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("continues with shared email login without writing OAuth config", () => {
    const { onNext } = renderAuthMethodStep();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(mutateMock).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  test.each(["success", "baseline failure"])(
    "OIDC save uses the saved baseline: %s",
    async (result) => {
      if (result === "baseline failure")
        fetchConfigMock.mockRejectedValue(
          new Error("Saved configuration unavailable"),
        );
      const { onNext } = renderAuthMethodStep();

      fireEvent.click(screen.getByRole("radio", { name: /OIDC \/ Custom/ }));
      fireEvent.change(screen.getByLabelText("Client ID"), {
        target: { value: "oidc-client" },
      });
      fireEvent.change(screen.getByLabelText("Client Secret"), {
        target: { value: "oidc-secret" },
      });
      fireEvent.change(screen.getByLabelText("Issuer URL"), {
        target: { value: "https://issuer.example.com" },
      });
      fireEvent.change(screen.getByLabelText("Authorization URL"), {
        target: { value: "https://issuer.example.com/auth" },
      });
      fireEvent.change(screen.getByLabelText("Token URL"), {
        target: { value: "https://issuer.example.com/token" },
      });
      fireEvent.change(screen.getByLabelText("Userinfo URL"), {
        target: { value: "https://issuer.example.com/userinfo" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      if (result === "baseline failure") {
        expect(
          await screen.findByText("Saved configuration unavailable"),
        ).toBeTruthy();
        expect(mutateMock).not.toHaveBeenCalled();
        expect(onNext).not.toHaveBeenCalled();
        return;
      }
      await waitFor(() => {
        expect(mutateMock).toHaveBeenCalledWith({
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
              defaultRole: "member",
              missingGroupsPolicy: "deny_login",
              removeMissingOidcMemberships: true,
            }),
          }),
        });
      });
      await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    },
  );

  test("applies the Keycloak preset while retaining saved fields Setup does not expose", async () => {
    const savedDirectory = {
      type: "keycloak",
      baseUrl: "https://directory.example.test/prefix",
      realm: "office",
      clientId: "read-client",
      clientSecret: "***REDACTED***",
      claimValueMode: "path",
    };
    const savedClaims = {
      subject: "personId",
      email: "mail",
      emailVerified: "verified",
      name: "label",
      avatar: "image",
      groups: "realm.groups",
      groupsSource: "id_token",
    };
    const savedMapping = {
      enabled: true,
      defaultRole: "reader",
      removeMissingOidcMemberships: false,
      missingGroupsPolicy: "allow_without_memberships",
      unknownGroups: "deny_login",
      mappings: [{ providerGroup: "RetainGroup", targetUnitId: "retained-ou" }],
    };
    fetchConfigMock.mockResolvedValue({
      admin: {
        adminConfigValues: {
          modules: [
            {
              module: "oauth",
              groups: [
                {
                  fields: [
                    {
                      path: "oauth.providers.oidc",
                      value: {
                        clientId: "old-login",
                        clientSecret: "***REDACTED***",
                        groupDirectory: savedDirectory,
                        claims: savedClaims,
                        groupMapping: savedMapping,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const { onNext } = renderAuthMethodStep();

    fireEvent.click(screen.getByRole("radio", { name: /OIDC \/ Custom/ }));
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "oidc-client" },
    });
    fireEvent.change(screen.getByLabelText("Client Secret"), {
      target: { value: "oidc-secret" },
    });
    fireEvent.change(screen.getByLabelText("Issuer URL"), {
      target: { value: "https://keycloak.example.test/realms/myoxus" },
    });
    fireEvent.click(screen.getByText("Keycloak"));
    fireEvent.click(
      screen.getByRole("button", { name: "Apply preset endpoints" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        module: "oauth",
        key: "providers.oidc",
        value: expect.objectContaining({
          issuerUrl: "https://keycloak.example.test/realms/myoxus",
          discoveryUrl:
            "https://keycloak.example.test/realms/myoxus/.well-known/openid-configuration",
          authUrl:
            "https://keycloak.example.test/realms/myoxus/protocol/openid-connect/auth",
          tokenUrl:
            "https://keycloak.example.test/realms/myoxus/protocol/openid-connect/token",
          userinfoUrl:
            "https://keycloak.example.test/realms/myoxus/protocol/openid-connect/userinfo",
          jwksUrl:
            "https://keycloak.example.test/realms/myoxus/protocol/openid-connect/certs",
          claims: savedClaims,
          groupDirectory: savedDirectory,
          groupMapping: savedMapping,
        }),
      });
    });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(fetchConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ id: "adminConfigValuesQuery" }),
      }),
    );
  });

  test("can save optional OIDC group mapping without workspace or admin roles", async () => {
    renderAuthMethodStep();

    fireEvent.click(screen.getByRole("radio", { name: /OIDC \/ Custom/ }));
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "oidc-client" },
    });
    fireEvent.change(screen.getByLabelText("Client Secret"), {
      target: { value: "oidc-secret" },
    });
    fireEvent.change(screen.getByLabelText("Issuer URL"), {
      target: { value: "https://auth.example.test/application/o/myoxus/" },
    });
    fireEvent.click(screen.getByText("Authentik"));
    fireEvent.click(
      screen.getByRole("button", { name: "Apply preset endpoints" }),
    );
    fireEvent.click(
      screen.getByLabelText("Set up OIDC group mapping during setup"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add mapping" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findAllByText("admin.security.oauth.mapping-group-required"),
    ).not.toHaveLength(0);
    expect(mutateMock).not.toHaveBeenCalled();
    const mappingInput = screen.getByPlaceholderText("finance/managers");
    mappingInput.focus();
    fireEvent.change(screen.getByPlaceholderText("finance/managers"), {
      target: { value: "finance/managers" },
    });
    expect(screen.getByPlaceholderText("finance/managers")).toBe(mappingInput);
    expect(document.activeElement).toBe(mappingInput);
    fireEvent.change(screen.getByLabelText("Search organization unit"), {
      target: { value: "unit-finance" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        module: "oauth",
        key: "providers.oidc",
        value: expect.objectContaining({
          groupMapping: expect.objectContaining({
            enabled: true,
            defaultRole: "member",
            mappings: [
              {
                providerGroup: "finance/managers",
                targetUnitId: "unit-finance",
                role: "member",
              },
            ],
          }),
        }),
      });
    });
    const savedValue = mutateMock.mock.calls.at(-1)?.[0]?.value;
    expect(JSON.stringify(savedValue)).not.toMatch(/workspace|is_admin|admin/i);
  });
});
