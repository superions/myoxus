// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { useService } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import { ReferenceCard, IconButton, Box } from "@myoxus/ui-facade";
import { FileIconHtmlIcon, ExpandIcon } from "@myoxus/icons/react";
import {
  EmbedLoomModel,
  type EmbedIframeBlockModel,
  type EmbedHtmlModel,
  type EmbedGithubModel,
  type EmbedGithubBlockUrlData,
  EmbedYoutubeModel,
  type EmbedFigmaModel,
  type EmbedYoutubeBlockUrlData,
} from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT } from "@virgultum/core/consts";
import { LinkPreviewCache } from "@virgultum/core/services";
import { EmbedIframeService } from "@virgultum/core/services/data";
import {
  iframeSandbox,
  safeGetIframeSrc,
} from "@virgultum/embeds/provider-data";
import { EditorIframeStatusCard } from "../../view-extensions/editor-view/editor-chrome/iframe-status-card";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils";
import { buildImageProxyURL } from "@virgultum/core/adapters";
import {
  queryEmbedLoomData,
  queryEmbedYoutubeData,
  loomUrlRegex,
  youtubeUrlRegex,
  queryEmbedGithubApiData,
  queryEmbedGithubData,
  formatForgeCardDate,
  parseCardUrl,
  parseGitForgeUrl,
  resolveGitForgeFamily,
  resolveGitForgeTargets,
} from "@virgultum/embeds/provider-data";
import { ServerService } from "../../../modules/server";
import { workspaceLinkPreview } from "../../view-extensions/link-preview-service/link-preview-service";
import { EditorFigmaCard } from "../../view-extensions/editor-view/editor-chrome/figma-card";
import { EditorGithubCard } from "../../view-extensions/editor-view/editor-chrome/github-card";
import { EditorLoomCard } from "../../view-extensions/editor-view/editor-chrome/loom-card";
import { EditorYoutubeCard } from "../../view-extensions/editor-view/editor-chrome/youtube-card";
import type { PageIntent } from "./plain-page-input";

type Model = EmbedLoomModel | EmbedYoutubeModel | EmbedFigmaModel;
type Props<T> = {
  model: T;
  readonly: boolean;
  handoff: (i: PageIntent) => void;
};
export function HtmlCard({ model, readonly, handoff }: Props<EmbedHtmlModel>) {
  const t = useI18n(),
    wrap = useRef<HTMLDivElement>(null),
    [active, setActive] = useState(false),
    [full, setFull] = useState(false);
  useEffect(() => {
    const update = () => setFull(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const fullscreen = () => {
    void (
      document.fullscreenElement === wrap.current
        ? document.exitFullscreen()
        : wrap.current?.requestFullscreen()
    )?.catch(console.error);
  };
  const select = () => {
    if (readonly || model.store.readonly) setActive(true);
    else
      handoff({ kind: "block-command", id: model.id, flavour: model.flavour });
  };
  return (
    <div
      data-page-html=""
      data-block-id={model.id}
      contentEditable={false}
      tabIndex={-1}
      style={{ height: EMBED_CARD_HEIGHT.html }}
    >
      <ReferenceCard
        size="preview"
        contained
        fullHeight
        orientation="vertical"
        icon={<FileIconHtmlIcon />}
        title={t["com.myoxus.editor.embed.html-title"]()}
        onDoubleClick={fullscreen}
        preview={
          model.props.html ? (
            <Box ref={wrap} h="100%" pos="relative">
              <iframe
                title="HTML"
                sandbox="allow-scripts"
                loading="lazy"
                scrolling="no"
                width="100%"
                height="100%"
                srcDoc={`<style>body{margin:0}</style>${model.props.html}`}
              />
              {!active && !full && (
                <Box pos="absolute" inset={0} onClick={select} />
              )}
              <div data-html-fullscreen="">
                <IconButton
                  icon={<ExpandIcon />}
                  tooltip={t[
                    "com.myoxus.workbench.split-view-menu.full-screen"
                  ]()}
                  onClick={fullscreen}
                />
              </div>
            </Box>
          ) : (
            t["com.myoxus.editor.embed.empty"]()
          )
        }
      />
    </div>
  );
}
export function ForgeCard({
  model,
  readonly,
  handoff,
}: Props<EmbedGithubModel>) {
  const t = useI18n(),
    base = useService(ServerService).server.baseUrl;
  const preview = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const { url, style } = model.props;
  const prev = useRef(url),
    [snap, setSnap] = useState<{
      url: string;
      loading: boolean;
      reset: boolean;
      data: Partial<EmbedGithubBlockUrlData>;
    }>();
  const identity = parseGitForgeUrl(url);
  useEffect(() => {
    const replaced = prev.current !== url;
    prev.current = url;
    const abort = new AbortController(),
      fresh = () =>
        !abort.signal.aborted &&
        model.store.getModelById(model.id) === model &&
        model.props.url === url;
    const id = parseGitForgeUrl(url),
      write = () => !readonly && !model.store.readonly;
    const empty = {
      status: null,
      statusReason: null,
      assignees: null,
      title: null,
      description: null,
      createdAt: null,
      image: null,
    };
    if (
      write() &&
      (replaced ||
        (id &&
          Object.entries(id).some(
            ([k, v]) => Reflect.get(model.props, k) !== v,
          )))
    )
      model.store.withoutTransact(() =>
        model.store.updateBlock(model, {
          ...(replaced ? empty : {}),
          ...(id ?? { owner: "", repo: "", githubId: "", githubType: "issue" }),
        }),
      );
    const all = replaced || (!model.props.title && !model.props.description);
    setSnap({ url, reset: replaced, loading: all, data: {} });
    const query = all
      ? queryEmbedGithubData(model, preview, abort.signal)
      : queryEmbedGithubApiData(model, abort.signal);
    void query
      .then((data) => {
        if (!fresh()) return;
        const patch = all
          ? { ...empty, ...data }
          : data.status
            ? {
                status: data.status,
                statusReason: data.statusReason,
                createdAt: data.createdAt,
                assignees: data.assignees,
              }
            : {};
        // Editable cards follow the live model after a refresh; retaining a
        // second snapshot here would mask metadata changes made by a peer.
        if (write()) {
          if (
            Object.entries(patch).some(
              ([k, v]) =>
                JSON.stringify(Reflect.get(model.props, k)) !==
                JSON.stringify(v),
            )
          )
            model.store.updateBlock(model, patch);
          setSnap({ url, loading: false, reset: false, data: {} });
        } else setSnap({ url, loading: false, reset: replaced, data: patch });
      })
      .catch(() => {
        if (fresh())
          setSnap({ url, loading: false, reset: replaced, data: {} });
      });
    return () => abort.abort();
  }, [url, model, preview, readonly]);
  const target = resolveGitForgeTargets(url),
    current = snap?.url === url ? snap : undefined;
  const content = {
    ...(current?.reset || prev.current !== url ? {} : model.props),
    ...current?.data,
  };
  const opened = (value: string) => {
    const u = normalizeUrl(value);
    if (u && isValidUrl(u)) window.open(u, "_blank", "noopener,noreferrer");
  };
  return (
    <div
      data-page-forge=""
      data-block-id={model.id}
      tabIndex={-1}
      contentEditable={false}
    >
      <EditorGithubCard
        controls={{
          inSurface: false,
          selected: false,
          style,
          family: resolveGitForgeFamily(url),
          host: target?.host ?? parseCardUrl(url)?.host ?? "",
          repository: identity ? `${identity.owner}/${identity.repo}` : "",
          date: formatForgeCardDate(content.createdAt, t.language),
          title: content.title ?? null,
          description: content.description ?? null,
          image: content.image
            ? buildImageProxyURL(
                content.image,
                new URL(BUILD_CONFIG.imageProxyUrl, base).href,
              )
            : null,
          loading: !!current?.loading,
          type: identity?.githubType ?? "issue",
          status: content.status ?? null,
          statusReason: content.statusReason ?? null,
          assignees: content.assignees ?? null,
          open: () => opened(url),
          openAssignee: (who) => {
            if (target)
              opened(`${target.profileOrigin}/${encodeURIComponent(who)}`);
          },
          select: () => {
            if (!readonly && !model.store.readonly)
              handoff({
                kind: "block-command",
                id: model.id,
                flavour: model.flavour,
              });
          },
        }}
      />
    </div>
  );
}
export function PageIframe({
  model,
  readonly,
  handoff,
}: {
  model: EmbedIframeBlockModel;
  readonly: boolean;
  handoff: (i: PageIntent) => void;
}) {
  const service = model.store.get(EmbedIframeService);
  const base = useService(ServerService).server.baseUrl;
  const preview = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const { url, iframeUrl } = model.props,
    config = url ? service.getConfig(url) : undefined,
    options = config?.options;
  const prev = useRef(url);
  const [retry, setRetry] = useState(0),
    [interactive, setInteractive] = useState(false);
  const [answer, setAnswer] = useState<{
    url: string;
    src?: string;
    error?: boolean;
  }>();
  useEffect(() => {
    const changed = prev.current !== url;
    prev.current = url;
    setInteractive(false);
    if (!url) return;
    if (!changed && !retry && iframeUrl) {
      setAnswer({ url, src: iframeUrl });
      return;
    }
    const abort = new AbortController();
    const live = () =>
      !abort.signal.aborted &&
      model.store.getModelById(model.id) === model &&
      model.props.url === url;
    setAnswer(undefined);
    void Promise.all([
      service.getEmbedIframeData(url, abort.signal),
      preview.query(url, abort.signal),
    ])
      .then(([data, meta]) => {
        if (!live()) return;
        const src =
          data?.iframe_url ?? (data?.html && safeGetIframeSrc(data.html));
        if (!src) {
          setAnswer({ url, error: true });
          return;
        }
        setAnswer({ url, src });
        if (!readonly && !model.store.readonly)
          model.store.updateBlock(model, {
            iframeUrl: src,
            title: data?.title || meta.title,
            description: data?.description || meta.description,
          });
      })
      .catch(() => {
        if (live()) setAnswer({ url, error: true });
      });
    return () => abort.abort();
  }, [model, preview, service, url, retry, iframeUrl, readonly]);
  const state = answer?.url === url ? answer : undefined;
  const src =
    state?.src && URL.canParse(state.src) ? new URL(state.src) : undefined;
  const usable =
    src?.protocol === "https:" && !!config && service.canEmbed(src.href);
  const select = (control?: string) => {
    if (readonly || model.store.readonly) {
      setInteractive(true);
      return;
    }
    handoff({
      kind: "block-command",
      id: model.id,
      flavour: model.flavour,
      control,
    });
  };
  return (
    <div
      data-block-id={model.id}
      data-page-iframe=""
      contentEditable={false}
      tabIndex={-1}
      onClick={() => select(!url ? "iframe-input" : undefined)}
      style={{
        position: "relative",
        borderRadius: options?.containerBorderRadius,
      }}
    >
      {usable && src ? (
        <>
          <iframe
            key={src.href}
            src={src.href}
            title={model.props.title || new URL(url).hostname}
            ref={(el) => {
              if (el && options?.style) el.style.cssText = options.style;
            }}
            sandbox={iframeSandbox(
              service.getConfig(src.href)?.name === config?.name
                ? config
                : undefined,
            )}
            loading="lazy"
            {...{ credentialless: true }}
            width={`${options?.widthPercent ?? 100}%`}
            height={options?.heightInNote ?? 152}
            allowFullScreen={options?.allowFullscreen}
            allow={options?.allow}
            referrerPolicy={
              options?.referrerpolicy as ReferrerPolicy | undefined
            }
            scrolling={
              options?.scrolling === undefined
                ? undefined
                : options.scrolling
                  ? "yes"
                  : "no"
            }
          />
          <span data-iframe-source="">{new URL(url).hostname}</span>
          {!interactive && <div data-iframe-guard="" />}
        </>
      ) : (
        <EditorIframeStatusCard
          controls={{
            status: !url
              ? "idle"
              : state?.error || state?.src
                ? "error"
                : "loading",
            message: url,
            inSurface: false,
            selected: false,
            readonly,
            edit: () => select("iframe-input"),
            retry: async () => setRetry((n) => n + 1),
          }}
        />
      )}
    </div>
  );
}
export default function PageProviderPlayer({
  model,
  readonly,
  handoff,
}: {
  model: Model;
  readonly: boolean;
  handoff: (i: PageIntent) => void;
}) {
  const base = useService(ServerService).server.baseUrl;
  const preview = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const proxy = (value?: string | null) =>
    value
      ? buildImageProxyURL(
          value,
          new URL(BUILD_CONFIG.imageProxyUrl, base).href,
        )
      : null;
  const { url, title, description, style } = model.props;
  const previous = useRef<string>(undefined),
    [snapshot, setSnapshot] = useState<{
      url: string;
      loading: boolean;
      replaced?: boolean;
      data?: Partial<EmbedYoutubeBlockUrlData>;
    }>();
  const video =
    model instanceof EmbedLoomModel || model instanceof EmbedYoutubeModel;
  const id = video
    ? (url.match(
        model instanceof EmbedLoomModel ? loomUrlRegex : youtubeUrlRegex,
      )?.[1] ?? (!url ? model.props.videoId : null))
    : null;
  const [print, setPrint] = useState(() => window.matchMedia("print").matches);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    if (!(model instanceof EmbedYoutubeModel)) return;
    const m = window.matchMedia("print"),
      refresh = () => setPrint(m.matches);
    m.addEventListener("change", refresh);
    return () => m.removeEventListener("change", refresh);
  }, [model]);
  useEffect(() => {
    const changed = previous.current !== undefined && previous.current !== url;
    previous.current = url;
    setReading(false);
    if (!video) return;
    const writable = () => !readonly && !model.store.readonly;
    if ((changed || id !== model.props.videoId) && writable())
      model.store.withoutTransact(() =>
        model.store.updateBlock(model, {
          videoId: id,
          ...(changed
            ? {
                title: null,
                description: null,
                image: null,
                ...(model instanceof EmbedYoutubeModel
                  ? { creator: null, creatorImage: null, creatorUrl: null }
                  : {}),
              }
            : {}),
        }),
      );
    if (!changed && (model.props.title || model.props.description)) return;
    const abort = new AbortController(),
      live = () =>
        !abort.signal.aborted &&
        model.store.getModelById(model.id) === model &&
        model.props.url === url;
    setSnapshot({ url, loading: true, replaced: changed });
    const query =
      model instanceof EmbedLoomModel
        ? queryEmbedLoomData(model, abort.signal)
        : queryEmbedYoutubeData(model, preview, abort.signal);
    void query
      .then((data) => {
        if (!live()) return;
        setSnapshot({
          url,
          loading: false,
          replaced: changed && !writable(),
          data: writable() ? undefined : data,
        });
        if (writable() && Object.keys(data).length)
          model.store.updateBlock(model, data);
      })
      .catch(() => {
        if (live())
          setSnapshot({
            url,
            loading: false,
            replaced: changed && !writable(),
          });
      });
    return () => abort.abort();
  }, [model, video, id, preview, url, readonly]);
  const current = snapshot?.url === url ? snapshot : undefined;
  const stored =
    !current?.replaced &&
    (previous.current === undefined || previous.current === url);
  const common = {
    url,
    description:
      current?.data?.description ?? (stored ? description : null) ?? null,
    selected: reading,
    showOverlay: !reading,
    open: () => {
      const link = normalizeUrl(model.props.url);
      if (isValidUrl(link)) window.open(link, "_blank", "noopener,noreferrer");
    },
    select: (event: MouseEvent) => {
      event.stopPropagation();
      if (readonly || model.store.readonly) setReading(true);
      else
        handoff({
          kind: "block-command",
          id: model.id,
          flavour: model.flavour,
        });
    },
  };
  const data = {
    ...common,
    title: current?.data?.title ?? (stored ? title : null),
    loading: !!current?.loading,
    videoId: id ?? null,
    image: proxy(
      current?.data?.image ?? (video && stored ? model.props.image : null),
    ),
  };
  return (
    <div
      data-block-id={model.id}
      data-page-provider={model.flavour}
      tabIndex={-1}
      contentEditable={false}
      style={{ height: EMBED_CARD_HEIGHT[style] }}
    >
      {model instanceof EmbedLoomModel ? (
        <EditorLoomCard controls={{ ...data, title: data.title ?? "Loom" }} />
      ) : model instanceof EmbedYoutubeModel ? (
        <EditorYoutubeCard
          controls={{
            ...data,
            title: data.title ?? "YouTube",
            printImage: print,
            creator:
              current?.data?.creator ?? (stored ? model.props.creator : null),
            creatorImage: proxy(
              current?.data?.creatorImage ??
                (stored ? model.props.creatorImage : null),
            ),
          }}
        />
      ) : (
        <EditorFigmaCard
          controls={{
            ...common,
            title: title ?? "Figma",
            iframeUrl: `https://www.figma.com/embed?embed_host=virgultum&url=${encodeURIComponent(url)}`,
          }}
        />
      )}
    </div>
  );
}
