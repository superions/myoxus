// SPDX-License-Identifier: MIT

import {
  useQuery,
  type UseQueryConfig,
} from "@myoxus/core/components/hooks/use-query";
import { AuthService, GraphQLService } from "@myoxus/core/modules/server";
import { UrlService } from "@myoxus/core/modules/url";
import { UserFriendlyError } from "@myoxus/error";
import {
  type CalendarAccountsQuery,
  calendarAccountsQuery,
  type CalendarProvidersQuery,
  calendarProvidersQuery,
  CalendarProviderType,
  type GraphQLQuery,
  linkCalDavAccountMutation,
  linkCalendarAccountMutation,
  unlinkCalendarAccountMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { GoogleIcon, LinkIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  Button,
  DialogFooterActions,
  FormRow,
  Input,
  Loading,
  Menu,
  MenuItem,
  Modal,
  MyoxusText,
  notify,
  SettingsControlEmpty,
  SettingsFieldGroup,
  SettingsStatusText,
  SettingsToolbar,
  SettingWrapper,
  Stack,
  StatusDot,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListText,
} from "../../primitives";

type CalendarAccount = NonNullable<
  CalendarAccountsQuery["currentUser"]
>["calendarAccounts"][number];

type CalendarCalDAVProvider = NonNullable<
  CalendarProvidersQuery["serverConfig"]
>["calendarCalDAVProviders"][number];

const providerMeta = {
  [CalendarProviderType.Google]: {
    label: "Google Calendar",
    icon: <GoogleIcon />,
  },
  [CalendarProviderType.CalDAV]: {
    label: "CalDAV",
    icon: <LinkIcon />,
  },
} satisfies Partial<
  Record<CalendarProviderType, { label: string; icon: ReactNode }>
>;

const CalDAVLinkDialog = ({
  open,
  providers,
  onClose,
  onLinked,
}: {
  open: boolean;
  providers: CalendarCalDAVProvider[];
  onClose: () => void;
  onLinked: () => void;
}) => {
  const t = useI18n();
  const gqlService = useService(GraphQLService);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<{
    provider?: string;
    username?: string;
    password?: string;
  }>({});

  const selectedProvider = useMemo(() => {
    if (providerId) {
      const match = providers.find((provider) => provider.id === providerId);
      if (match) {
        return match;
      }
    }
    return providers[0] ?? null;
  }, [providerId, providers]);

  useEffect(() => {
    if (!open) return;
    setProviderId(providers[0]?.id ?? null);
    setUsername("");
    setPassword("");
    setDisplayName("");
    setErrors({});
  }, [open, providers]);

  const handleProviderSelect = useCallback(
    (provider: CalendarCalDAVProvider) => {
      setProviderId(provider.id);
      setErrors((prev) => ({ ...prev, provider: undefined }));
    },
    [],
  );

  const handleUsernameInput = useCallback(
    (event: FormEvent<HTMLInputElement>) => {
      setUsername(event.currentTarget.value);
      setErrors((prev) => ({ ...prev, username: undefined }));
    },
    [],
  );

  const handlePasswordInput = useCallback(
    (event: FormEvent<HTMLInputElement>) => {
      setPassword(event.currentTarget.value);
      setErrors((prev) => ({ ...prev, password: undefined }));
    },
    [],
  );

  const handleDisplayNameInput = useCallback(
    (event: FormEvent<HTMLInputElement>) => {
      setDisplayName(event.currentTarget.value);
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    const nextErrors: {
      provider?: string;
      username?: string;
      password?: string;
    } = {};
    if (!selectedProvider) {
      nextErrors.provider =
        t["com.myoxus.integration.calendar.caldav.field.provider.error"]();
    }
    if (!username.trim()) {
      nextErrors.username =
        t["com.myoxus.integration.calendar.caldav.field.username.error"]();
    }
    if (!password) {
      nextErrors.password =
        t["com.myoxus.integration.calendar.caldav.field.password.error"]();
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    setSubmitting(true);
    try {
      await gqlService.gql({
        query: linkCalDavAccountMutation,
        variables: {
          input: {
            providerPresetId: selectedProvider.id,
            username: username.trim(),
            password,
            displayName: displayName.trim() || null,
          },
        },
      });
      onLinked();
      onClose();
    } catch (error) {
      const message =
        error instanceof UserFriendlyError ? error.message : String(error);
      notify.error({
        title: t["com.myoxus.integration.calendar.caldav.link.failed"](),
        message: message || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    displayName,
    gqlService,
    onClose,
    onLinked,
    password,
    selectedProvider,
    t,
    username,
  ]);

  return (
    <Modal
      open={open}
      title={t["com.myoxus.integration.calendar.caldav.link.title"]()}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      contentOptions={{
        "data-testid": "calendar-caldav-link-dialog",
      }}
    >
      <SettingsFieldGroup>
        <FormRow
          label={t["com.myoxus.integration.calendar.caldav.field.provider"]()}
          error={errors.provider}
          help={
            selectedProvider?.requiresAppPassword ? (
              <>
                {t[
                  "com.myoxus.integration.calendar.caldav.hint.app-password"
                ]()}
                {selectedProvider.docsUrl ? (
                  <>
                    {" "}
                    <MyoxusText
                      component="a"
                      href={selectedProvider.docsUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      tone="link"
                      typographySlot="body-small"
                    >
                      {t[
                        "com.myoxus.integration.calendar.caldav.hint.learn-more"
                      ]()}
                    </MyoxusText>
                  </>
                ) : null}
              </>
            ) : selectedProvider?.docsUrl ? (
              <MyoxusText
                component="a"
                href={selectedProvider.docsUrl}
                target="_blank"
                rel="noreferrer noopener"
                tone="link"
                typographySlot="body-small"
              >
                {t["com.myoxus.integration.calendar.caldav.hint.guide"]()}
              </MyoxusText>
            ) : null
          }
        >
          <Menu
            items={providers.map((provider) => (
              <MenuItem
                key={provider.id}
                onSelect={() => handleProviderSelect(provider)}
              >
                {provider.label}
              </MenuItem>
            ))}
            contentOptions={{ align: "start" }}
          >
            <Button
              block
              justifyContent="space-between"
              disabled={!providers.length}
            >
              {selectedProvider?.label ??
                t[
                  "com.myoxus.integration.calendar.caldav.field.provider.placeholder"
                ]()}
            </Button>
          </Menu>
        </FormRow>
        <FormRow
          label={t["com.myoxus.integration.calendar.caldav.field.username"]()}
          error={errors.username}
        >
          <Input
            value={username}
            onInput={handleUsernameInput}
            placeholder={t[
              "com.myoxus.integration.calendar.caldav.field.username.placeholder"
            ]()}
            status={errors.username ? "error" : "default"}
            disabled={submitting}
          />
        </FormRow>
        <FormRow
          label={t["com.myoxus.integration.calendar.caldav.field.password"]()}
          error={errors.password}
        >
          <Input
            value={password}
            onInput={handlePasswordInput}
            placeholder={t[
              "com.myoxus.integration.calendar.caldav.field.password.placeholder"
            ]()}
            type="password"
            status={errors.password ? "error" : "default"}
            disabled={submitting}
          />
        </FormRow>
        <FormRow
          label={t[
            "com.myoxus.integration.calendar.caldav.field.displayName"
          ]()}
        >
          <Input
            value={displayName}
            onInput={handleDisplayNameInput}
            placeholder={t[
              "com.myoxus.integration.calendar.caldav.field.displayName.placeholder"
            ]()}
            disabled={submitting}
          />
        </FormRow>
        <DialogFooterActions>
          <Button disabled={submitting} onClick={onClose}>
            {t["Cancel"]()}
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={submitting || !providers.length}
            onClick={() => void handleSubmit()}
          >
            {t["com.myoxus.integration.calendar.account.link"]()}
          </Button>
        </DialogFooterActions>
      </SettingsFieldGroup>
    </Modal>
  );
};

const CalendarAccountsSettingsContent = ({
  embedded = false,
}: {
  embedded?: boolean;
}) => {
  const t = useI18n();
  const gqlService = useService(GraphQLService);
  const urlService = useService(UrlService);
  const [linking, setLinking] = useState(false);
  const [unlinkingAccountId, setUnlinkingAccountId] = useState<string | null>(
    null,
  );
  const [openedExternalWindow, setOpenedExternalWindow] = useState(false);
  const [caldavDialogOpen, setCaldavDialogOpen] = useState(false);
  const makeConfig: <Query extends GraphQLQuery>(
    title: string,
  ) => UseQueryConfig<Query> = useCallback(
    (title) => ({
      suspense: false,
      revalidateOnFocus: openedExternalWindow,
      onError: (error) => {
        notify.error({ title, message: String(error) || undefined });
      },
    }),
    [openedExternalWindow],
  );

  const {
    data: accountsData,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useQuery(
    { query: calendarAccountsQuery },
    useMemo(
      () =>
        makeConfig(t["com.myoxus.integration.calendar.account.load-error"]()),
      [makeConfig, t],
    ),
  );

  const {
    data: providersData,
    isLoading: providersLoading,
    mutate: mutateProviders,
  } = useQuery(
    { query: calendarProvidersQuery },

    useMemo(
      () =>
        makeConfig(t["com.myoxus.integration.calendar.provider.load-error"]()),
      [makeConfig, t],
    ),
  );

  const accounts: CalendarAccount[] =
    accountsData?.currentUser?.calendarAccounts ?? [];
  const providers = useMemo(
    () => providersData?.serverConfig.calendarProviders ?? [],
    [providersData],
  );
  const caldavProviders =
    providersData?.serverConfig.calendarCalDAVProviders ?? [];
  const loading = accountsLoading || providersLoading;

  const providerOptions = useMemo(() => {
    return providers.map((provider) => {
      const meta = providerMeta[provider];
      return {
        provider,
        label: meta?.label ?? provider,
        icon: meta?.icon,
      };
    });
  }, [providers]);

  const handleLink = useCallback(
    async (provider: CalendarProviderType) => {
      if (provider === CalendarProviderType.CalDAV) {
        setCaldavDialogOpen(true);
        return;
      }

      setLinking(true);
      try {
        const data = await gqlService.gql({
          query: linkCalendarAccountMutation,
          variables: {
            input: {
              provider,
              redirectUri: window.location.href,
            },
          },
        });
        urlService.openExternal(data.linkCalendarAccount);
        setOpenedExternalWindow(true);
      } catch (error) {
        console.error("Failed to link calendar account", error);
        notify.error({
          title: t["com.myoxus.integration.calendar.auth.start-error"](),
        });
      } finally {
        setLinking(false);
      }
    },
    [gqlService, t, urlService],
  );

  const handleUnlink = useCallback(
    async (accountId: string) => {
      setUnlinkingAccountId(accountId);
      try {
        await gqlService.gql({
          query: unlinkCalendarAccountMutation,
          variables: {
            accountId,
          },
        });
        await mutateAccounts(
          (current) => {
            if (!current?.currentUser) {
              return current;
            }
            return {
              ...current,
              currentUser: {
                ...current.currentUser,
                calendarAccounts: current.currentUser.calendarAccounts.filter(
                  (account) => account.id !== accountId,
                ),
              },
            };
          },
          {
            revalidate: false,
          },
        );
      } catch (error) {
        console.error("Failed to unlink calendar account", error);
        notify.error({
          title: t["com.myoxus.integration.calendar.account.unlink-error"](),
        });
      } finally {
        setUnlinkingAccountId(null);
      }
    },
    [gqlService, mutateAccounts, t],
  );

  const panel = (
    <Stack data-myoxus-ui-role="calendar-accounts-panel">
      <SettingsToolbar
        layout="split"
        align="flex-start"
        justify="space-between"
        data-myoxus-ui-role="calendar-accounts-header"
      >
        <SettingsStatusText lineClamp={3}>
          {t["com.myoxus.integration.calendar.desc"]()}
        </SettingsStatusText>
        {providerOptions.length ? (
          <Menu
            items={providerOptions.map((option) => (
              <MenuItem
                key={option.provider}
                prefixIcon={option.icon}
                onSelect={() => void handleLink(option.provider)}
              >
                {option.label}
              </MenuItem>
            ))}
            contentOptions={{ align: "end" }}
          >
            <Button variant="primary" loading={linking}>
              {t["com.myoxus.integration.calendar.account.link"]()}
            </Button>
          </Menu>
        ) : (
          <Button variant="primary" disabled>
            {t["com.myoxus.integration.calendar.account.link"]()}
          </Button>
        )}
      </SettingsToolbar>

      {loading ? (
        <SettingsControlEmpty data-testid="calendar-accounts-loading">
          <Loading size={20} />
        </SettingsControlEmpty>
      ) : accounts.length ? (
        <SurfaceList
          label={t["com.myoxus.integration.calendar.name"]()}
          data-testid="calendar-accounts-list"
        >
          {accounts.map((account) => {
            const meta = providerMeta[account.provider];
            const title = account.displayName ?? account.email ?? account.id;
            const subtitle = account.displayName ? account.email : null;
            const showStatus =
              account.status !== "active" || Boolean(account.lastError);
            const statusMessage = account.lastError
              ? t["com.myoxus.integration.calendar.account.status.failed"]({
                  error: account.lastError,
                })
              : t[
                  "com.myoxus.integration.calendar.account.status.failed-reconnect"
                ]();

            return (
              <SurfaceListItem
                key={account.id}
                layout="row"
                alignItems="flex-start"
                justifyContent="space-between"
                data-testid="calendar-account-row"
                data-myoxus-ui-role="calendar-account-row"
              >
                <SurfaceListItemIcon tone="secondary">
                  {meta?.icon ?? <LinkIcon />}
                </SurfaceListItemIcon>
                <SurfaceListItemMain compact>
                  <SurfaceListText kind="title">{title}</SurfaceListText>
                  <SurfaceListMeta layout="card">
                    {subtitle ? (
                      <SettingsStatusText>{subtitle}</SettingsStatusText>
                    ) : null}
                    <SettingsStatusText>
                      {t["com.myoxus.integration.calendar.account.count"]({
                        count: String(account.calendarsCount),
                      })}
                    </SettingsStatusText>
                  </SurfaceListMeta>
                  {showStatus ? (
                    <StatusDot tone="error" label={statusMessage} />
                  ) : null}
                </SurfaceListItemMain>
                <SettingsToolbar>
                  <Button
                    variant="error"
                    disabled={unlinkingAccountId === account.id}
                    onClick={() => void handleUnlink(account.id)}
                  >
                    {t["com.myoxus.integration.calendar.account.unlink"]()}
                  </Button>
                </SettingsToolbar>
              </SurfaceListItem>
            );
          })}
        </SurfaceList>
      ) : (
        <SettingsControlEmpty data-testid="calendar-accounts-empty">
          {t["com.myoxus.integration.calendar.account.linked-empty"]()}
        </SettingsControlEmpty>
      )}
    </Stack>
  );

  return (
    <>
      <CalDAVLinkDialog
        open={caldavDialogOpen}
        providers={caldavProviders}
        onClose={() => setCaldavDialogOpen(false)}
        onLinked={() => {
          void Promise.all([mutateAccounts(), mutateProviders()]).catch(
            () => undefined,
          );
        }}
      />
      {embedded ? (
        panel
      ) : (
        <SettingWrapper title={t["com.myoxus.integration.calendar.name"]()}>
          {panel}
        </SettingWrapper>
      )}
    </>
  );
};

export const CalendarAccountsSettings = ({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) => {
  const authService = useService(AuthService);
  const status = useLiveData(authService.session.status$);

  if (status !== "authenticated") {
    return null;
  }

  return <CalendarAccountsSettingsContent embedded={embedded} />;
};
