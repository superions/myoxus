import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { type DocRecord, DocService } from "@myoxus/core/modules/doc";
import { PublicUserLabel } from "@myoxus/core/modules/server/views/public-user";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type AvatarProps,
  type MenuRef,
  PlaceholderText,
  PropertyValue,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import type { GroupHeaderProps } from "../explorer/types";
import { MemberSelectorInline } from "../member-selector";

const CreatedUsernameTip = ({ userName }: { userName: string }) => {
  const i18n = useI18n();
  return i18n.t("com.myoxus.page-properties.property.createdBy.tip", {
    userName,
  });
};
const UpdatedUsernameTip = ({ userName }: { userName: string }) => {
  const i18n = useI18n();
  return i18n.t("com.myoxus.page-properties.property.updatedBy.tip", {
    userName,
  });
};

const CreatedByUpdatedByAvatar = (props: {
  type: "CreatedBy" | "UpdatedBy";
  doc: DocRecord;
  size?: AvatarProps["size"];
  showName?: boolean;
  emptyFallback?: ReactNode;
}) => {
  const doc = props.doc;

  const userId = useLiveData(
    props.type === "CreatedBy" ? doc?.createdBy$ : doc?.updatedBy$,
  );

  if (userId) {
    return (
      <PublicUserLabel
        id={userId}
        size={props.size}
        showName={props.showName}
        align="center"
        tooltip={
          props.type === "CreatedBy" ? CreatedUsernameTip : UpdatedUsernameTip
        }
      />
    );
  }
  return props.emptyFallback === undefined ? (
    <NoRecordValue />
  ) : (
    props.emptyFallback
  );
};

const NoRecordValue = () => {
  const t = useI18n();
  return (
    <span>
      {t["com.myoxus.page-properties.property-user-avatar-no-record"]()}
    </span>
  );
};

const LocalUserValue = () => {
  const t = useI18n();
  return <span>{t["com.myoxus.page-properties.local-user"]()}</span>;
};

export const CreatedByValue = () => {
  const doc = useService(DocService).doc.record;
  const workspaceService = useService(WorkspaceService);
  const isCloud = workspaceService.workspace.flavour !== "local";

  if (!isCloud) {
    return (
      <PropertyValue readonly>
        <LocalUserValue />
      </PropertyValue>
    );
  }

  return (
    <PropertyValue readonly>
      <CreatedByUpdatedByAvatar type="CreatedBy" doc={doc} />
    </PropertyValue>
  );
};

export const UpdatedByValue = () => {
  const doc = useService(DocService).doc.record;
  const workspaceService = useService(WorkspaceService);
  const isCloud = workspaceService.workspace.flavour !== "local";

  if (!isCloud) {
    return (
      <PropertyValue readonly>
        <LocalUserValue />
      </PropertyValue>
    );
  }

  return (
    <PropertyValue readonly>
      <CreatedByUpdatedByAvatar type="UpdatedBy" doc={doc} />
    </PropertyValue>
  );
};

export const CreatedByUpdatedByFilterValue = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onChange?: (filter: FilterParams) => void;
}) => {
  const t = useI18n();
  const menuRef = useRef<MenuRef>(null);

  useEffect(() => {
    if (isDraft) {
      menuRef.current?.changeOpen(true);
    }
  }, [isDraft]);

  const selected = useMemo(
    () => filter.value?.split(",").filter(Boolean) ?? [],
    [filter],
  );

  const handleChange = useCallback(
    (selected: string[]) => {
      onChange?.({
        ...filter,
        value: selected.join(","),
      });
    },
    [filter, onChange],
  );

  return (
    <MemberSelectorInline
      placeholder={
        <PlaceholderText>{t["com.myoxus.filter.empty"]()}</PlaceholderText>
      }
      selected={selected}
      onChange={handleChange}
      ref={menuRef}
      onEditorClose={onDraftCompleted}
    />
  );
};

export const CreatedByDocListInlineProperty = ({ doc }: { doc: DocRecord }) => {
  return (
    <CreatedByUpdatedByAvatar
      doc={doc}
      type="CreatedBy"
      emptyFallback={null}
      showName={false}
    />
  );
};

export const UpdatedByDocListInlineProperty = ({ doc }: { doc: DocRecord }) => {
  return (
    <CreatedByUpdatedByAvatar
      type="UpdatedBy"
      doc={doc}
      showName={false}
      emptyFallback={null}
    />
  );
};

export const ModifiedByGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const userId = groupId;

  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      <PublicUserLabel id={userId} showName={false} align="center" />
    </PlainTextDocGroupHeader>
  );
};
