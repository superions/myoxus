import { computed, signal } from "@preact/signals-core";
import type {
  EmbedGithubModel,
  EmbedGithubStyles,
} from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
} from "@virgultum/core/services";
import { BlockSelection, isGfxBlockComponent } from "@virgultum/core/runtime";

import { EmbedBlockComponent } from "../common/embed-block-element.js";
import type { EmbedGithubBlockService } from "./embed-github-service.js";
import {
  parseCardUrl,
  formatForgeCardDate,
  parseGitForgeUrl,
  resolveGitForgeFamily,
  resolveGitForgeTargets,
} from "./git-forge.js";
import {
  refreshEmbedGithubStatus,
  refreshEmbedGithubUrlData,
} from "./utils.js";

export class EmbedGithubBlockComponent extends EmbedBlockComponent<
  EmbedGithubModel,
  EmbedGithubBlockService
> {
  protected override embedSelectionMode = "native" as const;

  private readonly _loading$ = signal(false);

  get loading() {
    return this._loading$.value;
  }
  set loading(value: boolean) {
    this._loading$.value = value;
  }

  override get _cardStyle(): (typeof EmbedGithubStyles)[number] {
    return super._cardStyle as (typeof EmbedGithubStyles)[number];
  }
  override set _cardStyle(value: (typeof EmbedGithubStyles)[number]) {
    super._cardStyle = value;
  }

  open = () => {
    let link = this.model.props.url;
    if (!link.match(/^[a-zA-Z]+:\/\//)) {
      link = "https://" + link;
    }
    window.open(link, "_blank");
  };

  refreshData = () => {
    refreshEmbedGithubUrlData(this, this.fetchAbortController.signal).catch(
      console.error,
    );
  };

  refreshStatus = () => {
    refreshEmbedGithubStatus(this, this.fetchAbortController.signal).catch(
      console.error,
    );
  };

  private _handleAssigneeClick(assignee: string) {
    const targets = resolveGitForgeTargets(this.model.props.url);
    const link = `${targets?.profileOrigin ?? "https://www.github.com"}/${assignee}`;
    window.open(link, "_blank");
  }

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  /**
   * The card URL was replaced: re-resolve the identity for the new resource,
   * clear the previous resource's metadata before loading the replacement so
   * the old number/status/assignees are never retained (GFC-05F), then load.
   * When the replacement URL has no recognized identity, the previous
   * identity props are cleared as well so an unsupported URL keeps a usable
   * original link without another resource's identity or metadata. Stale
   * responses are additionally guarded in the refresh functions (GFC-05G).
   */
  private _replaceResource() {
    const identity = parseGitForgeUrl(this.model.props.url);
    this.store.withoutTransact(() => {
      this.store.updateBlock(this.model, {
        status: null,
        statusReason: null,
        createdAt: null,
        assignees: null,
        title: null,
        description: null,
        image: null,
      });
      if (identity) {
        this.store.updateBlock(this.model, identity);
      } else {
        this.store.updateBlock(this.model, {
          owner: "",
          repo: "",
          githubType: "issue",
          githubId: "",
        });
      }
    });
    this.refreshData();
  }

  protected override mountEmbedContent(container: HTMLElement) {
    this._cardStyle = this.model.props.style;
    // Page follows the shared template; Canvas retains its stored renderer bounds.
    if (!isGfxBlockComponent(this)) {
      this.embedContainerStyle$.value = {
        ...this.embedContainerStyle$.peek(),
        height: "auto",
      };
    }

    // The URL is the source of truth for the persisted identity; re-resolve
    // it for every provider even when stale identity props exist (GFC-05F).
    const identity = parseGitForgeUrl(this.model.props.url);
    if (identity) {
      this.store.withoutTransact(() => {
        this.store.updateBlock(this.model, identity);
      });
    }

    this.store.withoutTransact(() => {
      if (!this.model.props.description && !this.model.props.title) {
        this.refreshData();
      } else {
        this.refreshStatus();
      }
    });

    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === "style") {
          this._cardStyle = this.model.props.style;
        }
        if (key === "url") {
          this._replaceResource();
        }
      }),
    );

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;

    const host = this.ownerDocument.createElement("div");
    host.style.display = "contents";
    container.replaceChildren(host);

    const state$ = computed(() => {
      void this.revision$.value;
      const {
        title,
        githubType,
        status,
        statusReason,
        owner,
        repo,
        createdAt,
        assignees,
        description,
        image,
        style,
        url,
      } = this.model.props;
      const targets = resolveGitForgeTargets(url);
      const fallbackHost = parseCardUrl(url)?.host ?? "";
      const dateText = formatForgeCardDate(
        createdAt,
        this.std.getOptional(EditorI18nProvider)?.locale$.value,
      );
      return {
        inSurface: isGfxBlockComponent(this),
        selected: this.selected$.value,
        style,
        family: resolveGitForgeFamily(url),
        host: targets?.host ?? fallbackHost,
        repository: owner || repo ? `${owner}/${repo}` : "",
        date: dateText,
        title,
        description,
        image: image ? this.store.get(ImageProxyService).buildUrl(image) : null,
        loading: this._loading$.value,
        type: githubType,
        status,
        statusReason,
        assignees,
        open: () => this.open(),
        openAssignee: (assignee: string) => this._handleAssigneeClick(assignee),
        select: () => {
          if (!this.store.readonly && !isGfxBlockComponent(this))
            this._selectBlock();
        },
      };
    });

    const unmount = chrome.mountGithubCard(host, state$);
    this.disposables.add(() => {
      unmount();
      host.remove();
    });
  }
}
