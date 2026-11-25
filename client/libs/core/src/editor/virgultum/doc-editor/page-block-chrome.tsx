// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { CommentIcon, LockIcon } from "@myoxus/icons/react";
import { useLiveData, useServiceOptional } from "@myoxus/infra";
import { Badge, Group, IconButton, Tooltip } from "@myoxus/ui-facade";
import type { TemplateRepeatBinding } from "@virgultum/core/models";
import {
  DefaultEditorI18nService,
  resolveEditorMessage,
  textProtectionMessages,
} from "@virgultum/core/services";
import type { BlockModel } from "@virgultum/core/store";
import { useMemo } from "react";
import { TemplateDocService } from "../../../modules/template-doc";
import { configureEditorI18n } from "../editor-i18n";

export function activeCommentIds(
  comments?: Record<string, boolean> | null,
): string[] {
  if (!comments) return [];
  return Object.entries(comments)
    .filter(([, active]) => active === true)
    .map(([id]) => id);
}

export function PageBlockCommentIndicator({
  comments,
  openThread,
}: {
  comments?: Record<string, boolean> | null;
  openThread?: (id: string) => void;
}) {
  const t = useI18n();
  const ids = activeCommentIds(comments);
  if (!ids.length) return null;
  const firstId = ids[0];
  const label = t["com.myoxus.editor.toolbar.comment"]();
  return (
    <span data-page-comment={firstId} contentEditable={false}>
      {openThread ? (
        <Tooltip content={label}>
          <IconButton
            size="sm"
            aria-label={label}
            icon={<CommentIcon />}
            onClick={(event) => {
              event.stopPropagation();
              openThread(firstId);
            }}
          />
        </Tooltip>
      ) : (
        <Badge tone="neutral" prefix={<CommentIcon />}>
          {ids.length}
        </Badge>
      )}
    </span>
  );
}

export function PageCitationBadge({
  identifier,
}: {
  identifier?: string | null;
}) {
  if (!identifier) return null;
  return (
    <Badge tone="neutral" data-page-citation-badge={identifier}>
      [{identifier}]
    </Badge>
  );
}

export function PageLineAttributesBar({
  model,
  textProtection,
  repeat,
  comments,
  readonly,
  openThread,
}: {
  model: BlockModel;
  textProtection?: "source" | "fixed";
  repeat?: TemplateRepeatBinding;
  comments?: Record<string, boolean> | null;
  readonly: boolean;
  openThread?: (id: string) => void;
}) {
  const commentIds = activeCommentIds(comments);
  const templateList = useServiceOptional(TemplateDocService)?.list;
  const isTemplate = useLiveData(
    useMemo(
      () =>
        readonly || !templateList
          ? undefined
          : templateList.isTemplate$(model.store.id),
      [readonly, templateList, model.store.id],
    ),
  );
  const i18n = useMemo(
    () => new DefaultEditorI18nService(configureEditorI18n()),
    [],
  );

  if (!textProtection && !repeat && !commentIds.length) return null;

  const protectionLabel = textProtection
    ? resolveEditorMessage(
        textProtection === "fixed"
          ? textProtectionMessages.fixed
          : textProtectionMessages.protect,
        i18n,
      )
    : null;

  const toggleSourceProtection = () => {
    if (
      readonly ||
      model.store.readonly ||
      !isTemplate ||
      textProtection !== "source" ||
      model.store.getModelById(model.id) !== model
    )
      return;
    model.store.captureSync();
    model.store.updateBlock(model, () => {
      Reflect.deleteProperty(
        model.props as Record<string, unknown>,
        "textProtection",
      );
    });
    model.store.captureSync();
  };

  return (
    <Group
      gap="2xs"
      wrap="nowrap"
      contentEditable={false}
      data-page-line-attributes=""
    >
      {repeat && (
        <Badge tone="info" data-page-repeat-badge={repeat.source}>
          {repeat.source}
        </Badge>
      )}
      {protectionLabel && (
        <Badge
          tone="neutral"
          prefix={<LockIcon />}
          data-page-protection-badge={textProtection}
          onClick={
            !readonly && isTemplate && textProtection === "source"
              ? toggleSourceProtection
              : undefined
          }
        >
          {protectionLabel}
        </Badge>
      )}
      <PageBlockCommentIndicator comments={comments} openThread={openThread} />
    </Group>
  );
}
