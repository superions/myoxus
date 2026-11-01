// SPDX-License-Identifier: AGPL-3.0-or-later

import { BrokenImageIcon, FileIcon, RefreshCwIcon } from "@myoxus/icons/react";
import {
  Button,
  MediaPreviewFrame,
  MediaPreviewIcon,
  MediaPreviewImage,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import { useState } from "react";

export type DatabaseFileReference = {
  blobKey: string;
  caption?: string | null;
  cover?: boolean | null;
  mime?: string | null;
  name?: string | null;
  size?: number | null;
};

export function databaseBlobUrl(workspaceId: string, blobKey: string) {
  const encodedKey = blobKey.split("/").map(encodeURIComponent).join("/");
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${encodedKey}`;
}

export function databaseCoverFile(files: DatabaseFileReference[]) {
  return (
    files.find((file) => file.cover && file.mime?.startsWith("image/")) ??
    files.find((file) => file.mime?.startsWith("image/")) ??
    null
  );
}

export function databaseFileMetadata(
  file: DatabaseFileReference,
  locale: string,
) {
  return [
    file.mime,
    typeof file.size === "number"
      ? `${new Intl.NumberFormat(locale).format(file.size)} B`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function DatabaseFilePreview({
  aspectRatio,
  emptyLabel,
  errorLabel,
  file,
  locale,
  retryLabel,
  workspaceId,
}: {
  aspectRatio?: string;
  emptyLabel: string;
  errorLabel: string;
  file: DatabaseFileReference | null;
  locale: string;
  retryLabel: string;
  workspaceId: string;
}) {
  const [failedKey, setFailedKey] = useState<string | null>(null);

  if (!file) {
    return (
      <MediaPreviewFrame
        aspectRatio={aspectRatio}
        data-testid="database-file-preview-empty"
      >
        <Stack align="center" gap="xs">
          <MediaPreviewIcon previewSize="file" aria-hidden="true">
            <FileIcon />
          </MediaPreviewIcon>
          <MyoxusText tone="secondary" typographySlot="caption">
            {emptyLabel}
          </MyoxusText>
        </Stack>
      </MediaPreviewFrame>
    );
  }

  const label = file.caption || file.name || file.blobKey;
  const image = file.mime?.startsWith("image/") ?? false;
  const failed = failedKey === file.blobKey;
  const metadata = databaseFileMetadata(file, locale);

  return (
    <MediaPreviewFrame
      aspectRatio={aspectRatio}
      data-testid="database-file-preview"
    >
      {image && !failed ? (
        <MediaPreviewImage
          alt={label}
          src={databaseBlobUrl(workspaceId, file.blobKey)}
          onError={() => setFailedKey(file.blobKey)}
        />
      ) : (
        <Stack align="center" gap="xs">
          <MediaPreviewIcon previewSize="file" aria-hidden="true">
            {failed ? <BrokenImageIcon /> : <FileIcon />}
          </MediaPreviewIcon>
          <MyoxusText
            tone={failed ? "warning" : "secondary"}
            typographySlot="caption"
          >
            {label}
          </MyoxusText>
          <MyoxusText
            tone={failed ? "warning" : "secondary"}
            typographySlot="caption"
          >
            {[errorLabel, metadata].filter(Boolean).join(" · ")}
          </MyoxusText>
          {failed ? (
            <Button
              variant="secondary"
              size="default"
              prefix={<RefreshCwIcon />}
              onClick={() => setFailedKey(null)}
            >
              {retryLabel}
            </Button>
          ) : null}
        </Stack>
      )}
    </MediaPreviewFrame>
  );
}
