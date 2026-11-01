// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsService } from "@myoxus/core/modules/doc";
import { DocSummaryService } from "@myoxus/core/modules/doc-summary";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { RefreshCwIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { BRANDING_STYLE_ID } from "@myoxus/theme";
import {
  AspectRatio,
  Box,
  IconButton,
  Image,
  MediaPreviewFrame,
  MediaPreviewImage,
  Stack,
  Text,
  observeIntersection,
  useResolvedDomTheme,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

import { requestPagePreview } from "./server-page-preview-request";

type ImageState = {
  identity: object;
  status: "ready" | "empty" | "unsupported" | "failed" | "unavailable";
  url?: string;
  contentHeight?: number;
  partial?: boolean | null;
  truncated?: boolean | null;
  revision?: string | null;
};

export function ServerPagePreview({
  pageId,
  fill = false,
  inventoryPreview,
}: {
  pageId: string;
  fill?: boolean;
  inventoryPreview?: "grid" | "masonry";
}) {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const account = useLiveData(server?.account$ ?? null);
  const config = useLiveData(server?.config$ ?? null);
  const docs = useService(DocsService);
  const doc = useLiveData(
    useMemo(() => docs.list.doc$(pageId), [docs, pageId]),
  );
  const trashed = useLiveData(doc?.trash$ ?? null);
  const updatedAt = useLiveData(doc?.updatedAt$ ?? null);
  const guard = useService(GuardService);
  const canRead = useLiveData(
    useMemo(() => guard.can$("Doc_Read", pageId), [guard, pageId]),
  );
  const summaries = useService(DocSummaryService);
  const summary = useLiveData(
    useMemo(
      () => LiveData.from(summaries.watchDocSummary(pageId, "cloud"), null),
      [summaries, pageId],
    ),
  );
  const theme = useResolvedDomTheme();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [revision, setRevision] = useState(0);
  const [image, setImage] = useState<ImageState>();
  const ownedImage = useRef<ImageState>(undefined);
  const allowed = !!doc && !trashed && canRead !== false && !!account;
  const identity = useMemo(
    () => ({}),
    [
      server,
      account?.id,
      workspace.id,
      pageId,
      updatedAt,
      theme,
      revision,
      allowed,
      config?.preview,
    ],
  );

  useEffect(() => {
    if (!element.current) return;
    return observeIntersection(element.current, (entry) =>
      setVisible(entry.isIntersecting),
    );
  }, []);

  useEffect(() => {
    // Observe existing storage notifications without acquiring a document store
    // or increasing its synchronization/indexing priority.
    return workspace.engine.doc.storage.subscribeDocUpdate((update) => {
      if (update.docId === pageId) setRevision((value) => value + 1);
    });
  }, [workspace, pageId]);

  useEffect(() => {
    let syncing = false;
    const subscription = workspace.engine.doc
      .docState$(pageId)
      .subscribe((state) => {
        if (syncing && state.synced) setRevision((value) => value + 1);
        syncing = state.syncing;
      });
    return () => subscription.unsubscribe();
  }, [workspace, pageId]);

  useEffect(() => {
    // An image upload may finish after the document referencing it was pushed.
    // Reuse the upload owner's completion signal rather than polling previews.
    let uploading = 0;
    const subscription = workspace.engine.blob.state$.subscribe((state) => {
      if (uploading > 0 && state.uploading === 0)
        setRevision((value) => value + 1);
      uploading = state.uploading;
    });
    return () => subscription.unsubscribe();
  }, [workspace]);

  useEffect(() => {
    const style = document.getElementById(BRANDING_STYLE_ID);
    if (!style) return;
    const observer = new MutationObserver(() =>
      setRevision((value) => value + 1),
    );
    observer.observe(style, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Artifact lifetime belongs to the mounted identity, not viewport demand.
    // Cleanup also covers access loss, account changes and recycled cards.
    return () => {
      if (ownedImage.current?.url) URL.revokeObjectURL(ownedImage.current.url);
      ownedImage.current = undefined;
    };
  }, [identity]);

  useEffect(() => {
    if (!visible || !allowed || !server || !config?.preview) return;
    if (ownedImage.current?.identity === identity) return;
    const controller = new AbortController();
    setImage(undefined);
    void requestPagePreview(
      server,
      workspace.id,
      pageId,
      config.preview,
      controller.signal,
      theme,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        const url =
          result.state === "ready"
            ? URL.createObjectURL(result.blob)
            : undefined;
        ownedImage.current = {
          identity,
          status: result.state,
          url,
          ...(result.state === "ready"
            ? {
                contentHeight: result.contentHeight,
                partial: result.partial,
                truncated: result.truncated,
                revision: result.revision,
              }
            : {}),
        };
        setImage(ownedImage.current);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Document preview request failed", { error });
        ownedImage.current = { identity, status: "failed" };
        setImage(ownedImage.current);
      });
    return () => {
      controller.abort();
    };
  }, [
    allowed,
    config?.preview,
    identity,
    pageId,
    server,
    theme,
    visible,
    workspace.id,
  ]);

  // A recycled card must never render another account/document's previous blob,
  // including the render before the old effect has been cleaned up.
  const current = allowed && image?.identity === identity ? image : undefined;
  const status =
    !allowed || !config?.preview
      ? "unavailable"
      : (current?.status ?? "loading");
  const content =
    current?.url && current.status === "ready" ? (
      inventoryPreview ? (
        <Image
          src={current.url}
          alt={summary ?? ""}
          fit="cover"
          style={{ objectPosition: "top" }}
          onError={() => {
            URL.revokeObjectURL(current.url!);
            ownedImage.current = { identity, status: "failed" };
            setImage(ownedImage.current);
          }}
        />
      ) : (
        <MediaPreviewImage
          src={current.url}
          alt={summary ?? ""}
          onError={() => {
            URL.revokeObjectURL(current.url!);
            ownedImage.current = { identity, status: "failed" };
            setImage(ownedImage.current);
          }}
        />
      )
    ) : (
      <Stack miw={0}>
        <Text>
          {status === "loading"
            ? t.Loading()
            : status === "empty"
              ? t["com.myoxus.selectPage.empty"]()
              : status === "unsupported"
                ? t["com.myoxus.edgelessMode"]()
                : t["com.myoxus.common.preview-unavailable"]()}
        </Text>
        {allowed && status !== "unavailable" && summary ? (
          <Text lineClamp={3}>{summary}</Text>
        ) : null}
        {status === "failed" ? (
          <IconButton
            aria-label={t.Retry()}
            tooltip={t.Retry()}
            icon={<RefreshCwIcon />}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setRevision((value) => value + 1);
            }}
          />
        ) : null}
      </Stack>
    );
  return (
    <Box
      ref={element}
      flex={fill && !inventoryPreview ? "1 1 0" : undefined}
      mih={fill && !inventoryPreview ? 0 : undefined}
      data-page-preview={status}
      data-doc-id={pageId}
    >
      {inventoryPreview ? (
        <Stack>
          <AspectRatio
            ratio={
              640 /
              (inventoryPreview === "masonry" && current?.status === "ready"
                ? (current.contentHeight ?? 400)
                : 400)
            }
          >
            {content}
          </AspectRatio>
          {current?.status === "ready" && current.partial ? (
            <Text>{t["com.myoxus.common.preview-partial"]()}</Text>
          ) : null}
        </Stack>
      ) : (
        <MediaPreviewFrame
          aspectRatio="640 / 400"
          fit={current?.status === "ready" ? "cover" : "contain"}
          fill={fill}
        >
          {content}
        </MediaPreviewFrame>
      )}
    </Box>
  );
}
