// SPDX-License-Identifier: AGPL-3.0-or-later
import { useService } from "@myoxus/infra";
import { useMemo, useEffect, useRef, useState } from "react";
import type {
  BookmarkBlockModel,
  LinkPreviewData,
} from "@virgultum/core/models";
import { LinkPreviewCache } from "@virgultum/core/services";
import { buildImageProxyURL } from "@virgultum/core/adapters";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils";
import { ServerService } from "../../../modules/server";
import { workspaceLinkPreview } from "../../view-extensions/link-preview-service/link-preview-service";
import { EditorBookmarkCard } from "../../view-extensions/editor-view/editor-chrome/bookmark-card";
import type { PageIntent } from "./plain-page-input";

export default function PageBookmarkCard({
  model,
  readonly,
  handoff,
}: {
  model: BookmarkBlockModel;
  readonly: boolean;
  handoff: (intent: PageIntent) => void;
}) {
  const base = useService(ServerService).server.baseUrl;
  const service = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const proxy = useMemo(
    () => new URL(BUILD_CONFIG.imageProxyUrl, base).href,
    [base],
  );
  const { url, style } = model.props;
  const previous = useRef<string | undefined>(undefined);
  const [result, setResult] = useState<{
    url: string;
    loading: boolean;
    error: boolean;
    data?: Partial<LinkPreviewData>;
  }>();
  useEffect(() => {
    const changed = previous.current !== undefined && previous.current !== url;
    previous.current = url;
    if (
      !changed &&
      (model.props.title || model.props.description) &&
      (style !== "vertical" || model.props.image)
    )
      return;
    const abort = new AbortController();
    const live = () =>
      !abort.signal.aborted &&
      model.store.getModelById(model.id) === model &&
      model.props.url === url;
    setResult({ url, loading: true, error: false });
    void service
      .query(url, abort.signal)
      .then((data) => {
        if (!live()) return;
        const error =
          !data.title && !data.icon && !data.image && !data.description;
        setResult({ url, loading: false, error, data });
        if (!error && !readonly && !model.store.readonly)
          model.store.updateBlock(model, {
            title: data.title ?? null,
            description: data.description ?? null,
            image: data.image ?? null,
            icon: data.icon ?? null,
          });
      })
      .catch(() => {
        if (live()) setResult({ url, loading: false, error: true });
      });
    return () => abort.abort();
  }, [service, model, url, style, readonly]);
  const current = result?.url === url ? result : undefined;
  const image = model.props.image ?? current?.data?.image,
    icon = model.props.icon ?? current?.data?.icon;
  return (
    <div
      data-block-id={model.id}
      data-page-bookmark={model.id}
      tabIndex={-1}
      contentEditable={false}
    >
      <EditorBookmarkCard
        controls={{
          title: model.props.title ?? current?.data?.title ?? null,
          description:
            model.props.description ?? current?.data?.description ?? null,
          image: image ? buildImageProxyURL(image, proxy) : null,
          icon: icon ? buildImageProxyURL(icon, proxy) : null,
          url,
          style:
            style === "vertical" || style === "cube" || style === "list"
              ? style
              : "horizontal",
          loading: !!current?.loading,
          error: !!current?.error,
          selected: false,
          inSurface: false,
          commentHighlighted: false,
          open: () => {
            const link = normalizeUrl(model.props.url);
            if (link && isValidUrl(link))
              window.open(link, "_blank", "noopener,noreferrer");
          },
          select: () => {
            if (!readonly && !model.store.readonly)
              handoff({
                kind: "block-command",
                flavour: model.flavour,
                id: model.id,
              });
          },
        }}
      />
    </div>
  );
}
