// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { FileTextIcon, ResetIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData } from "@myoxus/infra";
import {
  Card,
  Group,
  IconButton,
  Loading,
  MyoxusText,
  Scrollable,
  Stack,
  Typography,
} from "@myoxus/ui-facade";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { useEffect, useMemo, useState } from "react";
import { MarkdownPreview } from "./markdown-preview";
import { useAttachmentTextSelection } from "./use-text-selection";

export function textAttachmentFormat(name: string, mime: string) {
  if (
    /\.(md|markdown)$/i.test(name) ||
    /^text\/(markdown|x-markdown)$/i.test(mime)
  )
    return "markdown";
  if (/\.txt$/i.test(name) || mime.toLowerCase() === "text/plain")
    return "text";
  return null;
}

/** BOMs are explicit encoding declarations; invalid/binary data must not masquerade as decoded text. */
export function decodeAttachmentText(bytes: ArrayBuffer) {
  const data = new Uint8Array(bytes);
  const encoding =
    data[0] === 0xff && data[1] === 0xfe
      ? "utf-16le"
      : data[0] === 0xfe && data[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes("\0"))
    throw new Error("Binary attachment is not a text preview");
  return text;
}

export function TextAttachmentPreview({
  model,
  blobUrl,
}: {
  model: AttachmentBlockModel;
  blobUrl: string;
}) {
  const t = useI18n();
  const name = useLiveData(
    useMemo(() => LiveData.fromSignal(model.props.name$), [model]),
  );
  const format = textAttachmentFormat(name, model.props.type);
  const inSurface = model.parent?.flavour === "myoxus:surface";
  const selectText = useAttachmentTextSelection();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    text?: string;
    error?: boolean;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void (async () => {
      try {
        const response = await fetch(blobUrl, { signal: controller.signal });
        if (!response.ok) throw new Error("Attachment preview fetch failed");
        const text = decodeAttachmentText(await response.arrayBuffer());
        controller.signal.throwIfAborted();
        setResult({ url: blobUrl, text });
      } catch {
        if (!controller.signal.aborted)
          setResult({ url: blobUrl, error: true });
      }
    })();
    return () => controller.abort();
  }, [blobUrl, attempt]);
  const current = result?.url === blobUrl ? result : undefined;
  return (
    <Card
      withBorder
      padding="sm"
      fullHeight={inSurface}
      data-testid="attachment-text-preview"
    >
      <Stack gap="xs" h={inSurface ? "100%" : undefined}>
        <Group wrap="nowrap" gap="xs">
          <FileTextIcon />
          <MyoxusText truncate title={name}>
            <strong>{name}</strong>
          </MyoxusText>
        </Group>
        <Scrollable.Viewport
          autosize={!inSurface}
          fill={inSurface}
          maxHeight={inSurface ? undefined : "20em"}
          scrollbars="xy"
          aria-label={name}
          contentEditable={false}
          data-range-sync-exclude="true"
          // The attachment host suppresses block text selection; file content must remain selectable.
          style={{ userSelect: "text" }}
          {...selectText}
          onDragStartCapture={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onCopy={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
          }}
        >
          {!current ? (
            <Loading />
          ) : current.error ? (
            <Group>
              <MyoxusText tone="secondary">
                {t["com.myoxus.attachment.preview.error.title"]()}
              </MyoxusText>
              <IconButton
                icon={<ResetIcon />}
                tooltip={t["Retry"]()}
                onClick={() => setAttempt((value) => value + 1)}
              />
            </Group>
          ) : format === "markdown" ? (
            <Typography>
              <MarkdownPreview source={current.text ?? ""} />
            </Typography>
          ) : (
            <MyoxusText preserveWhitespace>{current.text}</MyoxusText>
          )}
        </Scrollable.Viewport>
      </Stack>
    </Card>
  );
}
