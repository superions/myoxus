// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import { WorkspacesService } from "@myoxus/core/modules/workspace/services/workspaces";
import { DatabaseFileMimeCategory } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  DownloadIcon,
  OpenInNewIcon,
  StarIcon,
  TrashIcon,
  UploadIcon,
} from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import {
  Button,
  Group,
  HiddenFileInput,
  IconButton,
  IconLink,
  InlineEdit,
  MyoxusText,
  Notice,
  Stack,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useRef, useState } from "react";

import {
  databaseBlobUrl,
  databaseFileMetadata,
  type DatabaseFileReference,
} from "../shared";
import type { DatabaseField } from "../types";

function acceptsMime(field: DatabaseField, mime: string) {
  const categories = field.config.files?.allowedMimeCategories ?? [
    DatabaseFileMimeCategory.Any,
  ];
  if (categories.includes(DatabaseFileMimeCategory.Any)) return true;
  if (
    categories.includes(DatabaseFileMimeCategory.Image) &&
    mime.startsWith("image/")
  )
    return true;
  if (
    categories.includes(DatabaseFileMimeCategory.Video) &&
    mime.startsWith("video/")
  )
    return true;
  if (
    categories.includes(DatabaseFileMimeCategory.Audio) &&
    mime.startsWith("audio/")
  )
    return true;
  if (
    categories.includes(DatabaseFileMimeCategory.Pdf) &&
    mime === "application/pdf"
  )
    return true;
  if (
    categories.includes(DatabaseFileMimeCategory.Archive) &&
    /(zip|gzip|tar|rar|7z)/i.test(mime)
  )
    return true;
  return (
    categories.includes(DatabaseFileMimeCategory.Document) &&
    /^(text\/|application\/(msword|rtf|vnd\.openxmlformats|vnd\.oasis))/i.test(
      mime,
    )
  );
}

function acceptAttribute(field: DatabaseField) {
  const categories = field.config.files?.allowedMimeCategories ?? [
    DatabaseFileMimeCategory.Any,
  ];
  if (categories.includes(DatabaseFileMimeCategory.Any)) return undefined;
  return (
    categories
      .flatMap((category) => {
        switch (category) {
          case DatabaseFileMimeCategory.Image:
            return ["image/*"];
          case DatabaseFileMimeCategory.Video:
            return ["video/*"];
          case DatabaseFileMimeCategory.Audio:
            return ["audio/*"];
          case DatabaseFileMimeCategory.Pdf:
            return ["application/pdf"];
          case DatabaseFileMimeCategory.Document:
            return ["text/*,.doc,.docx,.odt,.rtf"];
          case DatabaseFileMimeCategory.Archive:
            return [".zip,.gz,.tar,.rar,.7z"];
          default:
            return [];
        }
      })
      .join(",") || undefined
  );
}

export function DatabaseFilesCell({
  field,
  files,
  onChange,
  workspaceId,
}: {
  field: DatabaseField;
  files: DatabaseFileReference[];
  onChange: (files: DatabaseFileReference[]) => Promise<void>;
  workspaceId: string;
}) {
  const t = useI18n();
  const workspace = useServiceOptional(WorkspaceService)?.workspace;
  const workspaces = useServiceOptional(WorkspacesService);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async (next: DatabaseFileReference[]) => {
    setError(null);
    await onChange(next);
  };

  const commitAction = async (next: DatabaseFileReference[]) => {
    try {
      await commit(next);
    } catch {
      setError(t["com.myoxus.database.files.save-error"]());
    }
  };

  const compensate = async (keys: string[]) => {
    if (!workspace || !workspaces) return;
    const provider = workspaces.getWorkspaceFlavourProvider(workspace.meta);
    await Promise.allSettled(
      keys.map((key) => provider?.deleteBlob(workspaceId, key, false)),
    );
  };

  const upload = async (selected: File[]) => {
    if (!workspace || workspace.id !== workspaceId || selected.length === 0)
      return;
    const maxCount = field.config.files?.maxItemCount;
    const maxSize = field.config.files?.maxItemSize;
    if (
      (maxCount !== null &&
        maxCount !== undefined &&
        files.length + selected.length > maxCount) ||
      selected.some(
        (file) =>
          (maxSize !== null && maxSize !== undefined && file.size > maxSize) ||
          !acceptsMime(field, file.type),
      )
    ) {
      setError(t["com.myoxus.database.files.limit-error"]());
      return;
    }

    setBusy(true);
    setError(null);
    const uploaded: DatabaseFileReference[] = [];
    let cellCommitStarted = false;
    try {
      for (const file of selected) {
        const blobKey = await workspace.docCollection.blobSync.set(file);
        const reference = {
          blobKey,
          name: file.name,
          mime: file.type || null,
          size: file.size,
          caption: null,
          cover: false,
        } satisfies DatabaseFileReference;
        // Track the accepted key before remote upload so every failure after
        // blob creation can compensate through the same BlobService owner.
        uploaded.push(reference);
        await workspace.engine.blob.upload(blobKey);
      }
      cellCommitStarted = true;
      await commit([...files, ...uploaded]);
    } catch {
      await compensate(uploaded.map((file) => file.blobKey));
      setError(
        t[
          cellCommitStarted
            ? "com.myoxus.database.files.save-error"
            : "com.myoxus.database.files.upload-error"
        ](),
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const updateAt = (index: number, patch: Partial<DatabaseFileReference>) => {
    const next = files.map((file, candidate) =>
      candidate === index ? { ...file, ...patch } : file,
    );
    void commitAction(next);
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    [next[index], next[target]] = [next[target], next[index]];
    void commitAction(next);
  };

  return (
    <Stack gap="xs" data-testid="database-files-cell">
      {files.map((file, index) => {
        const url = databaseBlobUrl(workspaceId, file.blobKey);
        return (
          <SurfaceListItem key={file.blobKey} appearance="row" layout="column">
            <SurfaceListItemMain>
              <SurfaceListText kind="title">
                {file.name || file.blobKey}
              </SurfaceListText>
              {databaseFileMetadata(file, t.language) ? (
                <SurfaceListText kind="description">
                  {databaseFileMetadata(file, t.language)}
                </SurfaceListText>
              ) : null}
              <InlineEdit
                editable
                trigger="doubleClick"
                value={file.caption ?? ""}
                placeholder={t["com.myoxus.database.files.caption"]()}
                onChange={(caption) => {
                  if (caption !== (file.caption ?? ""))
                    updateAt(index, { caption });
                }}
              />
            </SurfaceListItemMain>
            <Group gap="xs" justify="flex-end" wrap="wrap">
              <IconButton
                icon={<StarIcon />}
                variant={file.cover ? "primary" : "plain"}
                aria-label={t["com.myoxus.database.files.cover"]()}
                tooltip={t["com.myoxus.database.files.cover"]()}
                onClick={() =>
                  void commitAction(
                    files.map((item, candidate) => ({
                      ...item,
                      cover: candidate === index ? !file.cover : false,
                    })),
                  )
                }
              />
              <IconButton
                icon={<ArrowUpSmallIcon />}
                disabled={index === 0}
                aria-label={t["com.myoxus.database.files.move-up"]()}
                onClick={() => move(index, -1)}
              />
              <IconButton
                icon={<ArrowDownSmallIcon />}
                disabled={index === files.length - 1}
                aria-label={t["com.myoxus.database.files.move-down"]()}
                onClick={() => move(index, 1)}
              />
              <IconLink
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t["com.myoxus.database.files.open"]()}
                tooltip={t["com.myoxus.database.files.open"]()}
                icon={<OpenInNewIcon />}
              />
              <IconLink
                href={url}
                download={file.name || true}
                aria-label={t["com.myoxus.database.files.download"]()}
                tooltip={t["com.myoxus.database.files.download"]()}
                icon={<DownloadIcon />}
              />
              <IconButton
                icon={<TrashIcon />}
                aria-label={t["com.myoxus.database.files.remove"]()}
                onClick={() =>
                  void commitAction(
                    files.filter((_, candidate) => candidate !== index),
                  )
                }
              />
            </Group>
          </SurfaceListItem>
        );
      })}
      {files.length === 0 ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.database.files.empty"]()}
        </MyoxusText>
      ) : null}
      {error ? <Notice tone="error" title={error} /> : null}
      {!workspace || workspace.id !== workspaceId ? (
        <Notice
          tone="warning"
          title={t["com.myoxus.database.files.unavailable"]()}
        />
      ) : null}
      <HiddenFileInput
        ref={inputRef}
        accept={acceptAttribute(field)}
        multiple
        onChange={(event) =>
          void upload(Array.from(event.currentTarget.files ?? []))
        }
      />
      <Button
        loading={busy}
        disabled={busy || !workspace || workspace.id !== workspaceId}
        variant="secondary"
        prefix={<UploadIcon />}
        onClick={() => inputRef.current?.click()}
      >
        {t["com.myoxus.database.files.add"]()}
      </Button>
    </Stack>
  );
}
