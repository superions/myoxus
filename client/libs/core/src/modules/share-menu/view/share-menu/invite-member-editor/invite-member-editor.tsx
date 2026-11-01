import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import {
  DocGrantedUsersService,
  type Member,
  MemberSearchService,
} from "@myoxus/core/modules/permissions";
import { UserFriendlyError } from "@myoxus/error";
import { DocRole, WorkspaceMemberStatus } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ArrowLeftBigIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  BadgeList,
  BadgeListItem,
  Button,
  DialogFooterActions,
  Divider,
  Group,
  InlineActionButton,
  Loading,
  Menu,
  MenuItem,
  MenuScrollableSection,
  MenuTrigger,
  MyoxusText,
  notify,
  RowInput,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import { debounce } from "lodash-es";
import {
  type CompositionEventHandler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso } from "react-virtuoso";

import { Scroller } from "../scroller";
import { MemberItem } from "./member-item";
import { SelectedMemberItem } from "./selected-member-item";

const getRoleName = (role: DocRole, t: ReturnType<typeof useI18n>) => {
  switch (role) {
    case DocRole.Manager:
      return t["com.myoxus.share-menu.option.permission.can-manage"]();
    case DocRole.Editor:
      return t["com.myoxus.share-menu.option.permission.can-edit"]();
    case DocRole.Reader:
      return t["com.myoxus.share-menu.option.permission.can-read"]();
    default:
      return "";
  }
};

export const InviteMemberEditor = ({
  onClickCancel,
}: {
  onClickCancel: () => void;
}) => {
  const t = useI18n();
  const [selectedMembers, setSelectedMembers] = useState<Member[]>([]);
  const docGrantedUsersService = useService(DocGrantedUsersService);
  const [inviteDocRoleType, setInviteDocRoleType] = useState<DocRole>(
    DocRole.Manager,
  );

  const memberSearchService = useService(MemberSearchService);

  useEffect(() => {
    // reset the search text when the component is mounted
    memberSearchService.reset();
    memberSearchService.loadMore();
  }, [memberSearchService]);

  const debouncedSearch = useMemo(
    () => debounce((value: string) => memberSearchService.search(value), 300),
    [memberSearchService],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [searchText, setSearchText] = useState("");

  const handleValueChange = useCallback(
    (value: string) => {
      setSearchText(value);
      if (!composing) {
        debouncedSearch(value);
      }
    },
    [composing, debouncedSearch],
  );
  const workspaceDialogService = useService(WorkspaceDialogService);

  const onInvite = useAsyncCallback(async () => {
    const selectedMemberIds = selectedMembers.map((member) => member.id);
    track.$.sharePanel.$.inviteUserDocRole({
      control: "member list",
      role: inviteDocRoleType,
    });
    try {
      await docGrantedUsersService.grantUsersRole(
        selectedMemberIds,
        inviteDocRoleType,
      );
      onClickCancel();

      notify.success({
        title: t["Invitation sent"](),
      });
    } catch (error) {
      const err = UserFriendlyError.fromAny(error);
      notify.error({
        title: t[`error.${err.name}`](err.data),
      });
    }
  }, [
    docGrantedUsersService,
    inviteDocRoleType,
    onClickCancel,
    selectedMembers,
    t,
  ]);

  const handleCompositionStart: CompositionEventHandler<HTMLInputElement> =
    useCallback(() => {
      setComposing(true);
    }, []);

  const handleCompositionEnd: CompositionEventHandler<HTMLInputElement> =
    useCallback(
      (e) => {
        setComposing(false);
        debouncedSearch(e.currentTarget.value);
      },
      [debouncedSearch],
    );

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);
  const onFocus = useCallback(() => {
    setFocused(true);
  }, []);
  const onBlur = useCallback(() => {
    setFocused(false);
  }, []);

  const handleRemoved = useCallback(
    (memberId: string) => {
      setSelectedMembers((prev) =>
        prev.filter((member) => member.id !== memberId),
      );
      focusInput();
    },
    [focusInput],
  );

  const switchToMemberManagementTab = useCallback(() => {
    workspaceDialogService.open("workspace-settings", {
      activeTab: "workspace:members",
    });
  }, [workspaceDialogService]);

  const handleClickMember = useCallback(
    (member: Member) => {
      setSelectedMembers((prev) => {
        if (prev.some((m) => m.id === member.id)) {
          // if the member is already in the list, just return
          return prev;
        }
        return [...prev, member];
      });
      setSearchText("");
      memberSearchService.search("");
      focusInput();
    },
    [focusInput, memberSearchService],
  );

  const handleRoleChange = useCallback((role: DocRole) => {
    setInviteDocRoleType(role);
  }, []);

  return (
    <Stack
      flex="1 1 auto"
      mih={0}
      data-myoxus-ui-role="share-menu-invite-editor"
    >
      <Button
        justifyContent="flex-start"
        onClick={onClickCancel}
        prefix={<ArrowLeftBigIcon />}
        variant="plain"
        data-myoxus-ui-role="share-menu-back-button"
      >
        {t["com.myoxus.share-menu.invite-editor.header"]()}
      </Button>
      <Divider space="xs" />
      <Stack flex="1 1 auto" mih={0}>
        <SurfaceListItem
          component="section"
          role="group"
          density="compact"
          fullWidth
          layout="row"
          alignItems="flex-start"
          selected={focused}
          onClick={focusInput}
          data-myoxus-ui-role="share-menu-invite-input"
        >
          <BadgeList grow maxHeight="compact" scrollable>
            {selectedMembers.map((member, idx) => {
              if (!member) {
                return null;
              }
              const onRemoved = () => handleRemoved(member.id);
              return (
                <SelectedMemberItem
                  key={member.id}
                  idx={idx}
                  onRemoved={onRemoved}
                  member={member}
                />
              );
            })}
            <BadgeListItem grow>
              <RowInput
                ref={inputRef}
                value={searchText}
                onChange={handleValueChange}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onFocus={onFocus}
                onBlur={onBlur}
                autoFocus
                block
                noBorder
                placeholder={
                  selectedMembers.length
                    ? ""
                    : t["com.myoxus.share-menu.invite-editor.placeholder"]()
                }
              />
            </BadgeListItem>
          </BadgeList>
          {!selectedMembers.length ? null : (
            <Group flex="0 0 auto">
              <RoleSelector
                inviteDocRoleType={inviteDocRoleType}
                onRoleChange={handleRoleChange}
              />
            </Group>
          )}
        </SurfaceListItem>
        <Result onClickMember={handleClickMember} />
      </Stack>
      <Divider space="xs" />
      <Group align="center" justify="space-between" wrap="wrap">
        <InlineActionButton onClick={switchToMemberManagementTab}>
          {t["com.myoxus.share-menu.invite-editor.manage-members"]()}
        </InlineActionButton>
        <DialogFooterActions>
          <Button onClick={onClickCancel}>{t["Cancel"]()}</Button>
          <Button
            variant="primary"
            disabled={!selectedMembers.length}
            onClick={onInvite}
          >
            {t["com.myoxus.share-menu.invite-editor.invite"]()}
          </Button>
        </DialogFooterActions>
      </Group>
    </Stack>
  );
};

const Result = ({
  onClickMember,
}: {
  onClickMember: (member: Member) => void;
}) => {
  const memberSearchService = useService(MemberSearchService);
  const searchText = useLiveData(memberSearchService.searchText$);
  const result = useLiveData(memberSearchService.result$);
  const isLoading = useLiveData(memberSearchService.isLoading$);

  const activeMembers = useMemo(() => {
    return result.filter(
      (member) => member.status === WorkspaceMemberStatus.Accepted,
    );
  }, [result]);

  const itemContentRenderer = useCallback(
    (_index: number, data: Member) => {
      return <MemberItem member={data} onSelect={onClickMember} />;
    },
    [onClickMember],
  );

  const t = useI18n();

  const loadMore = useCallback(() => {
    memberSearchService.loadMore();
  }, [memberSearchService]);

  if (!searchText) {
    return null;
  }

  if (!activeMembers || activeMembers.length === 0) {
    if (isLoading) {
      return <Loading />;
    }
    return (
      <MyoxusText tone="secondary" typographySlot="body-small">
        {t["com.myoxus.share-menu.invite-editor.no-found"]()}
      </MyoxusText>
    );
  }

  return activeMembers.length < 8 ? (
    <MenuScrollableSection maxHeight="default">
      {activeMembers.map((member) => (
        <MemberItem key={member.id} member={member} onSelect={onClickMember} />
      ))}
    </MenuScrollableSection>
  ) : (
    <Virtuoso
      components={{
        Scroller,
      }}
      data={activeMembers}
      itemContent={itemContentRenderer}
      endReached={loadMore}
    />
  );
};

const RoleSelector = ({
  inviteDocRoleType,
  onRoleChange,
}: {
  inviteDocRoleType: DocRole;
  onRoleChange: (role: DocRole) => void;
}) => {
  const t = useI18n();
  const currentRoleName = useMemo(
    () => getRoleName(inviteDocRoleType, t),
    [inviteDocRoleType, t],
  );

  const changeToAdmin = useCallback(
    () => onRoleChange(DocRole.Manager),
    [onRoleChange],
  );
  const changeToWrite = useCallback(() => {
    onRoleChange(DocRole.Editor);
  }, [onRoleChange]);
  const changeToRead = useCallback(() => {
    onRoleChange(DocRole.Reader);
  }, [onRoleChange]);
  return (
    <Menu
      contentOptions={{
        align: "end",
      }}
      items={
        <>
          <MenuItem
            onSelect={changeToAdmin}
            selected={inviteDocRoleType === DocRole.Manager}
          >
            {t["com.myoxus.share-menu.option.permission.can-manage"]()}
          </MenuItem>
          <MenuItem
            onSelect={changeToWrite}
            selected={inviteDocRoleType === DocRole.Editor}
          >
            {t["com.myoxus.share-menu.option.permission.can-edit"]()}
          </MenuItem>
          <MenuItem
            onSelect={changeToRead}
            selected={inviteDocRoleType === DocRole.Reader}
          >
            {t["com.myoxus.share-menu.option.permission.can-read"]()}
          </MenuItem>
        </>
      }
    >
      <MenuTrigger variant="plain">{currentRoleName}</MenuTrigger>
    </Menu>
  );
};
