// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

type LinkedCalendarAccount = NonNullable<
  CalendarAccountsQuery["currentUser"]
>["calendarAccounts"][number];

type CalDavProviderPreset = NonNullable<
  CalendarProvidersQuery["serverConfig"]
>["calendarCalDAVProviders"][number];

const PROVIDER_DISPLAY = {
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

interface CalDavFormErrors {
  provider?: string;
  username?: string;
  password?: string;
}

const CalDavLinkModal = ({
  open,
  providers,
  onClose,
  onLinked,
}: {
  open: boolean;
  providers: CalDavProviderPreset[];
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
  const [errors, setErrors] = useState<CalDavFormErrors>({});

  const activeProvider = useMemo(
    () =>
      (providerId
        ? providers.find((item) => item.id === providerId)
        : undefined) ??
      providers[0] ??
      null,
    [providerId, providers],
  );

  useEffect(() => {
    if (!open) return;
    setProviderId(providers[0]?.id ?? null);
    setUsername("");
    setPassword("");
    setDisplayName("");
    setErrors({});
  }, [open, providers]);

  const handleSubmit = useCallback(async () => {
    const nextErrors: CalDavFormErrors = {};
    if (!activeProvider) {
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
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSubmitting(true);
    try {
      await gqlService.gql({
        query: linkCalDavAccountMutation,
        variables: {
          input: {
            providerPresetId: activeProvider!.id,
            username: username.trim(),
            password,
            displayName: displayName.trim() || null,
          },
        },
      });
      onLinked();
      onClose();
    } catch (error) {
      const detail =
        error instanceof UserFriendlyError ? error.message : String(error);
      notify.error({
        title: t["com.myoxus.integration.calendar.caldav.link.failed"](),
        message: detail || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    activeProvider,
    displayName,
    gqlService,
    onClose,
    onLinked,
    password,
    t,
    username,
  ]);

  const renderProviderHelp = () => {
    if (!activeProvider) {
      return null;
    }
    if (activeProvider.requiresAppPassword) {
      return (
        <>
          {t["com.myoxus.integration.calendar.caldav.hint.app-password"]()}
          {activeProvider.docsUrl ? (
            <>
              {" "}
              <MyoxusText
                component="a"
                href={activeProvider.docsUrl}
                target="_blank"
                rel="noreferrer noopener"
                tone="link"
                typographySlot="body-small"
              >
                {t["com.myoxus.integration.calendar.caldav.hint.learn-more"]()}
              </MyoxusText>
            </>
          ) : null}
        </>
      );
    }
    if (activeProvider.docsUrl) {
      return (
        <MyoxusText
          component="a"
          href={activeProvider.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
          tone="link"
          typographySlot="body-small"
        >
          {t["com.myoxus.integration.calendar.caldav.hint.guide"]()}
        </MyoxusText>
      );
    }
    return null;
  };

  return (
    <Modal
      open={open}
      title={t["com.myoxus.integration.calendar.caldav.link.title"]()}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      contentOptions={{ "data-testid": "calendar-caldav-link-dialog" }}
    >
      <SettingsFieldGroup>
        <FormRow
          label={t["com.myoxus.integration.calendar.caldav.field.provider"]()}
          error={errors.provider}
          help={renderProviderHelp()}
        >
          <Menu
            items={providers.map((provider) => (
              <MenuItem
                key={provider.id}
                onSelect={() => {
                  setProviderId(provider.id);
                  setErrors((prev) => ({ ...prev, provider: undefined }));
                }}
              >
                {provider.label}
              </MenuItem>
            ))}
            contentOptions={{ align: "start" }}
          >
            <Button
              block
              justifyContent="space-between"
              disabled={providers.length === 0}
            >
              {activeProvider?.label ??
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
            onInput={(event: FormEvent<HTMLInputElement>) => {
              setUsername(event.currentTarget.value);
              setErrors((prev) => ({ ...prev, username: undefined }));
            }}
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
            onInput={(event: FormEvent<HTMLInputElement>) => {
              setPassword(event.currentTarget.value);
              setErrors((prev) => ({ ...prev, password: undefined }));
            }}
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
            onInput={(event: FormEvent<HTMLInputElement>) =>
              setDisplayName(event.currentTarget.value)
            }
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
            disabled={submitting || providers.length === 0}
            onClick={() => void handleSubmit()}
          >
            {t["com.myoxus.integration.calendar.account.link"]()}
          </Button>
        </DialogFooterActions>
      </SettingsFieldGroup>
    </Modal>
  );
};

const CalendarAccountsPanel = ({
  embedded = false,
}: {
  embedded?: boolean;
}) => {
  const t = useI18n();
  const gqlService = useService(GraphQLService);
  const urlService = useService(UrlService);
  const [linking, setLinking] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [awaitingOAuthReturn, setAwaitingOAuthReturn] = useState(false);
  const [caldavModalOpen, setCaldavModalOpen] = useState(false);

  const buildQueryConfig = useCallback(
    <Q extends GraphQLQuery>(errorTitle: string): UseQueryConfig<Q> => ({
      suspense: false,
      revalidateOnFocus: awaitingOAuthReturn,
      onError: (error) => {
        notify.error({
          title: errorTitle,
          message: String(error) || undefined,
        });
      },
    }),
    [awaitingOAuthReturn],
  );

  const {
    data: accountsData,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useQuery(
    { query: calendarAccountsQuery },
    useMemo(
      () =>
        buildQueryConfig(
          t["com.myoxus.integration.calendar.account.load-error"](),
        ),
      [buildQueryConfig, t],
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
        buildQueryConfig(
          t["com.myoxus.integration.calendar.provider.load-error"](),
        ),
      [buildQueryConfig, t],
    ),
  );

  const accounts: LinkedCalendarAccount[] =
    accountsData?.currentUser?.calendarAccounts ?? [];
  const providers = useMemo(
    () => providersData?.serverConfig.calendarProviders ?? [],
    [providersData],
  );
  const caldavProviders =
    providersData?.serverConfig.calendarCalDAVProviders ?? [];
  const loading = accountsLoading || providersLoading;

  const providerMenuEntries = useMemo(
    () =>
      providers.map((provider) => {
        const display = PROVIDER_DISPLAY[provider];
        return {
          provider,
          label: display?.label ?? provider,
          icon: display?.icon,
        };
      }),
    [providers],
  );

  const handleLinkProvider = useCallback(
    async (provider: CalendarProviderType) => {
      if (provider === CalendarProviderType.CalDAV) {
        setCaldavModalOpen(true);
        return;
      }

      setLinking(true);
      try {
        const result = await gqlService.gql({
          query: linkCalendarAccountMutation,
          variables: {
            input: {
              provider,
              redirectUri: window.location.href,
            },
          },
        });
        urlService.openExternal(result.linkCalendarAccount);
        setAwaitingOAuthReturn(true);
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

  const handleUnlinkAccount = useCallback(
    async (accountId: string) => {
      setUnlinkingId(accountId);
      try {
        await gqlService.gql({
          query: unlinkCalendarAccountMutation,
          variables: { accountId },
        });
        await mutateAccounts(
          (current) => {
            if (!current?.currentUser) return current;
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
          { revalidate: false },
        );
      } catch (error) {
        console.error("Failed to unlink calendar account", error);
        notify.error({
          title: t["com.myoxus.integration.calendar.account.unlink-error"](),
        });
      } finally {
        setUnlinkingId(null);
      }
    },
    [gqlService, mutateAccounts, t],
  );

  const content = (
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
        {providerMenuEntries.length > 0 ? (
          <Menu
            items={providerMenuEntries.map((entry) => (
              <MenuItem
                key={entry.provider}
                prefixIcon={entry.icon}
                onSelect={() => void handleLinkProvider(entry.provider)}
              >
                {entry.label}
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
      ) : accounts.length > 0 ? (
        <SurfaceList
          label={t["com.myoxus.integration.calendar.name"]()}
          data-testid="calendar-accounts-list"
        >
          {accounts.map((account) => {
            const display = PROVIDER_DISPLAY[account.provider];
            const title = account.displayName ?? account.email ?? account.id;
            const subtitle = account.displayName ? account.email : null;
            const hasWarning =
              account.status !== "active" || Boolean(account.lastError);
            const statusText = account.lastError
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
                  {display?.icon ?? <LinkIcon />}
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
                  {hasWarning ? (
                    <StatusDot tone="error" label={statusText} />
                  ) : null}
                </SurfaceListItemMain>
                <SettingsToolbar>
                  <Button
                    variant="error"
                    disabled={unlinkingId === account.id}
                    onClick={() => void handleUnlinkAccount(account.id)}
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
      <CalDavLinkModal
        open={caldavModalOpen}
        providers={caldavProviders}
        onClose={() => setCaldavModalOpen(false)}
        onLinked={() => {
          void Promise.all([mutateAccounts(), mutateProviders()]).catch(
            () => undefined,
          );
        }}
      />
      {embedded ? (
        content
      ) : (
        <SettingWrapper title={t["com.myoxus.integration.calendar.name"]()}>
          {content}
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

  return <CalendarAccountsPanel embedded={embedded} />;
};
