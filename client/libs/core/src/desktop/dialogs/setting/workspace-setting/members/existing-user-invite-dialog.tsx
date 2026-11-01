/**
 * ExistingUserInviteDialog
 *
 * In-modal search + invite flow for adding *existing* server users to a
 * workspace by picking them from a name-typed search. This is an alternative
 * to the e-mail-based invite flow: useful when the admin knows the user is
 * already registered on the server and wants to skip the e-mail round-trip.
 *
 * The dialog is rendered inside the main "Invite Members" modal
 * (see `cloud-members-panel.tsx`) and is **not** gated by deployment type.
 * The backing GraphQL mutation (`inviteServerUserById`) enforces its own
 * permission checks: the caller must be a workspace Owner/Admin.
 *
 * History: this component started life as `SelfhostInviteDialog`
 * (P100-WF-G) and was only ever rendered on selfhosted instances.  P123-INV-01
 * generalised it: the server-side mutation works on any deployment type, and
 * the ability to invite an already-registered user is independent of whether
 * the server runs standalone or in a managed SaaS.
 */
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceMembersService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import {
  inviteServerUserByIdMutation,
  serverUsersQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useState } from "react";

import {
  Avatar,
  Badge,
  Button,
  FormRow,
  Input,
  Loading,
  notify,
  SettingsControlEmpty,
  SettingsControlList,
  SettingsListItemTitle,
  Stack,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListMeta,
} from "../../primitives";

interface ServerUserResult {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Debounce hook: returns a debounced version of the value after `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export const ExistingUserInviteDialog = ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const t = useI18n();
  const workspaceServerService = useService(WorkspaceServerService);
  const membersService = useService(WorkspaceMembersService);
  const members = useLiveData(membersService.members.pageMembers$);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ServerUserResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  const debouncedSearch = useDebounced(search, 300);

  const memberIds = new Set(members?.map((member) => member.id) ?? []);

  useEffect(() => {
    if (!debouncedSearch.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const server = workspaceServerService.server;
    if (!server) {
      setIsSearching(false);
      return;
    }
    server
      .gql({
        query: serverUsersQuery,
        variables: { search: debouncedSearch, skip: 0, take: 20 },
      })
      .then((data) => {
        if (!cancelled) {
          setResults(data.serverUsers ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, workspaceServerService]);

  const onInvite = useAsyncCallback(
    async (userId: string) => {
      const server = workspaceServerService.server;
      if (!server) return;
      setInvitingId(userId);
      try {
        await server.gql({
          query: inviteServerUserByIdMutation,
          variables: { workspaceId, userId, role: "Collaborator" },
        });
        notify.success({
          title: t["com.myoxus.workspace.invite.existing-user.invite-button"](),
        });
        membersService.members.revalidate();
      } catch (e) {
        notify.error({ title: UserFriendlyError.fromAny(e).message });
      } finally {
        setInvitingId(null);
      }
    },
    [workspaceId, workspaceServerService, membersService, t],
  );

  const hasSearchTerm = debouncedSearch.trim().length > 0;

  return (
    <Stack
      data-testid="existing-user-invite-dialog"
      data-myoxus-ui-role="existing-user-invite-dialog"
    >
      <FormRow label={t["com.myoxus.workspace.invite.existing-user.title"]()}>
        <Input
          block
          placeholder={t[
            "com.myoxus.workspace.invite.existing-user.search-placeholder"
          ]()}
          value={search}
          onChange={setSearch}
          data-testid="existing-user-invite-search-input"
        />
      </FormRow>

      {isSearching ? (
        <SurfaceListItem
          component="div"
          appearance="row"
          density="compact"
          layout="row"
          alignItems="center"
          data-testid="existing-user-list"
          data-myoxus-ui-role="existing-user-search-loading"
        >
          <Loading />
          <SettingsControlEmpty>
            {t["com.myoxus.settings.member.loading"]()}
          </SettingsControlEmpty>
        </SurfaceListItem>
      ) : results.length === 0 && hasSearchTerm ? (
        <SettingsControlEmpty data-testid="existing-user-list">
          {t["com.myoxus.db.member.no-results"]()}
        </SettingsControlEmpty>
      ) : results.length === 0 ? (
        <SettingsControlEmpty data-testid="existing-user-list">
          {t["com.myoxus.workspace.invite.existing-user.search-placeholder"]()}
        </SettingsControlEmpty>
      ) : (
        <SettingsControlList
          data-myoxus-ui-role="existing-user-result-list"
          data-testid="existing-user-list"
        >
          {results.map((user) => {
            const alreadyMember = memberIds.has(user.id);
            return (
              <SurfaceListItem
                key={user.id}
                component="div"
                appearance="row"
                density="compact"
                layout="row"
                alignItems="center"
                justifyContent="space-between"
                muted={alreadyMember}
                data-already-member={alreadyMember}
                data-myoxus-ui-role="existing-user-result-row"
                data-testid={`existing-user-row-${user.id}`}
              >
                <Avatar
                  size="sm"
                  url={user.avatarUrl}
                  name={user.name}
                  colorfulFallback
                />
                <SurfaceListItemMain compact grow>
                  <SettingsListItemTitle title={user.name} truncate>
                    {user.name}
                  </SettingsListItemTitle>
                </SurfaceListItemMain>
                <SurfaceListMeta layout="row-cluster">
                  {alreadyMember ? (
                    <Badge tone="neutral">
                      {t[
                        "com.myoxus.workspace.invite.existing-user.already-member"
                      ]()}
                    </Badge>
                  ) : (
                    <Button
                      loading={invitingId === user.id}
                      disabled={invitingId !== null}
                      onClick={() => onInvite(user.id)}
                      data-testid={`existing-user-invite-btn-${user.id}`}
                    >
                      {t[
                        "com.myoxus.workspace.invite.existing-user.invite-button"
                      ]()}
                    </Button>
                  )}
                </SurfaceListMeta>
              </SurfaceListItem>
            );
          })}
        </SettingsControlList>
      )}
    </Stack>
  );
};
