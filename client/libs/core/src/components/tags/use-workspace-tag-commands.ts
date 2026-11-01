// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  TagService,
  useArchiveTagConfirmModal,
} from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { notify, type TagColorRole } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import type { TagLike } from "./types";

export type WorkspaceTagErrorKind =
  "invalid" | "conflict" | "archived" | "forbidden" | "not-found" | "general";

const errorLabelKeys = {
  invalid: "com.myoxus.tags.error.invalid",
  conflict: "com.myoxus.tags.error.conflict",
  archived: "com.myoxus.tags.error.archived",
  forbidden: "com.myoxus.tags.error.forbidden",
  "not-found": "com.myoxus.tags.error.not-found",
  general: "com.myoxus.common.operation-failed",
} as const;

function collectErrorCodes(error: unknown, codes: string[]) {
  if (!error || typeof error !== "object") {
    return;
  }
  const value = error as {
    code?: unknown;
    name?: unknown;
    type?: unknown;
    extensions?: {
      code?: unknown;
      name?: unknown;
      type?: unknown;
      data?: { code?: unknown } | null;
    };
  };
  for (const candidate of [
    value.code,
    value.name,
    value.type,
    value.extensions?.code,
    value.extensions?.name,
    value.extensions?.type,
    value.extensions?.data?.code,
  ]) {
    if (typeof candidate === "string") {
      codes.push(candidate);
    }
  }
}

export function workspaceTagErrorKind(error: unknown): WorkspaceTagErrorKind {
  const codes: string[] = [];
  collectErrorCodes(error, codes);
  if (
    codes.some((code) =>
      [
        "MIX_WORKSPACE_TAG_INVALID_NAME",
        "MIX_WORKSPACE_TAG_INVALID_COLOR",
        "MIX_WORKSPACE_TAG_CROSS_WORKSPACE",
      ].includes(code),
    )
  ) {
    return "invalid";
  }
  if (codes.includes("MIX_WORKSPACE_TAG_DUPLICATE_SLUG")) {
    return "conflict";
  }
  if (codes.includes("MIX_WORKSPACE_TAG_ARCHIVED_WRITE")) {
    return "archived";
  }
  if (codes.includes("MIX_WORKSPACE_TAG_FORBIDDEN")) {
    return "forbidden";
  }
  if (codes.includes("MIX_WORKSPACE_TAG_NOT_FOUND")) {
    return "not-found";
  }
  return "general";
}

export function useWorkspaceTagCommands() {
  const t = useI18n();
  const tagList = useService(TagService).tagList;

  const errorMessage = useCallback(
    (error: unknown) => t[errorLabelKeys[workspaceTagErrorKind(error)]](),
    [t],
  );
  const reportError = useCallback(
    (error: unknown) => {
      notify.error({ title: errorMessage(error) });
    },
    [errorMessage],
  );
  const archiveOptions = useMemo(
    () => ({
      archiveTag: (tagId: string) => tagList.archiveTag(tagId),
      onError: reportError,
    }),
    [reportError, tagList],
  );
  const confirmArchive = useArchiveTagConfirmModal(archiveOptions);

  const createTag = useCallback(
    async (
      name: string,
      color: TagColorRole,
      description?: string,
    ): Promise<TagLike> => {
      try {
        const created = await tagList.createTag(name, color, description);
        notify({ title: t["com.myoxus.tags.create-tag.toast.success"]() });
        return {
          id: created.id,
          name: created.value$.value,
          color: created.color$.value,
          description: created.description$.value,
          archived: created.archived$.value,
        };
      } catch (error) {
        reportError(error);
        throw error;
      }
    },
    [reportError, t, tagList],
  );

  const renameTag = useCallback(
    async (id: string, name: string) => {
      try {
        const tag = tagList.tagByTagId$(id).value;
        if (!tag) {
          reportError({
            extensions: { code: "MIX_WORKSPACE_TAG_NOT_FOUND" },
          });
          return false;
        }
        await tag.rename(name);
        notify({ title: t["com.myoxus.tags.edit-tag.toast.success"]() });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [reportError, t, tagList],
  );

  const recolorTag = useCallback(
    async (id: string, color: TagColorRole) => {
      try {
        const tag = tagList.tagByTagId$(id).value;
        if (!tag) {
          reportError({
            extensions: { code: "MIX_WORKSPACE_TAG_NOT_FOUND" },
          });
          return false;
        }
        await tag.changeColor(color);
        notify({ title: t["com.myoxus.tags.edit-tag.toast.success"]() });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [reportError, t, tagList],
  );

  const updateTag = useCallback(
    async (
      id: string,
      next: { name: string; color: TagColorRole; description?: string },
    ): Promise<boolean> => {
      const tag = tagList.tagByTagId$(id).value;
      if (!tag) {
        reportError({ extensions: { code: "MIX_WORKSPACE_TAG_NOT_FOUND" } });
        return false;
      }
      try {
        if (tag.value$.value !== next.name) {
          await tag.rename(next.name);
        }
        if (tag.color$.value !== next.color) {
          await tag.changeColor(next.color);
        }
        if (
          next.description !== undefined &&
          tag.description$.value !== next.description
        ) {
          await tag.changeDescription(next.description);
        }
        notify({ title: t["com.myoxus.tags.edit-tag.toast.success"]() });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [reportError, t, tagList],
  );

  const archiveTags = useCallback(
    (ids: readonly string[]) => {
      const activeIds = Array.from(new Set(ids)).filter(
        (id) => !tagList.tagByTagId$(id).value?.archived$.value,
      );
      return activeIds.length
        ? confirmArchive(activeIds)
        : Promise.resolve(false);
    },
    [confirmArchive, tagList],
  );

  const restoreTag = useCallback(
    async (id: string) => {
      try {
        await tagList.restoreTag(id);
        notify({ title: t["com.myoxus.tags.status.restored"]() });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [reportError, t, tagList],
  );

  const deleteTagPermanently = useCallback(
    async (id: string) => {
      try {
        await tagList.deleteTagPermanently(id);
        notify({ title: t["com.myoxus.tags.delete-tags.toast"]() });
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    [reportError, t, tagList],
  );

  return useMemo(
    () => ({
      archiveTags,
      createTag,
      deleteTagPermanently,
      errorMessage,
      recolorTag,
      renameTag,
      reportError,
      restoreTag,
      updateTag,
    }),
    [
      archiveTags,
      createTag,
      deleteTagPermanently,
      errorMessage,
      recolorTag,
      renameTag,
      reportError,
      restoreTag,
      updateTag,
    ],
  );
}
