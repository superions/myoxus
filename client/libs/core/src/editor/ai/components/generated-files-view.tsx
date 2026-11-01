// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { DownloadIcon } from "@myoxus/icons/react";
import {
  Alert,
  Group,
  IconButton,
  MyoxusLoader,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import type { CopilotGeneratedFile } from "./ai-chat-messages/type";

/** One projection for live exports and restored/copied message references. */
export function GeneratedFilesView({
  files,
  pending,
  failed,
  download,
}: {
  files: CopilotGeneratedFile[];
  pending: boolean;
  failed: boolean;
  download: (file: CopilotGeneratedFile) => void;
}) {
  const t = useI18n();
  return (
    <Stack data-testid="chat-generated-files" aria-busy={pending}>
      {files.map((file) => (
        <Group key={file.id}>
          <MyoxusText truncate title={file.fileName}>
            {file.fileName}
          </MyoxusText>
          <MyoxusText tone="secondary">
            {file.format.toUpperCase()} ·{" "}
            {new Intl.NumberFormat(t.language, {
              style: "unit",
              unit: "kilobyte",
              maximumFractionDigits: 1,
            }).format(file.sizeBytes / 1000)}
          </MyoxusText>
          <IconButton
            size="small"
            aria-label={t["com.myoxus.attachment.download"]()}
            tooltip={t["com.myoxus.attachment.download"]()}
            disabled={pending}
            onClick={() => download(file)}
          >
            <DownloadIcon />
          </IconButton>
        </Group>
      ))}
      {pending ? (
        <Group role="status">
          <MyoxusLoader />
          <MyoxusText>{t["com.myoxus.ai.file-export.pending"]()}</MyoxusText>
        </Group>
      ) : null}
      {failed ? (
        <Alert
          role="alert"
          color="myoxusError"
          title={t["com.myoxus.ai.file-export.failed"]()}
        />
      ) : null}
    </Stack>
  );
}
