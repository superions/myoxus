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
import { property } from "lit/decorators.js";

import { EmbedBlockComponent } from "../common/embed-block-element.js";
import type { EmbedGithubBlockService } from "./embed-github-service.js";
import {
  parseCardUrl,
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
  override _cardStyle: (typeof EmbedGithubStyles)[number] = "horizontal";

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

  override connectedCallback() {
    super.connectedCallback();
    this._cardStyle = this.model.props.style;

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
        if (key === "url") {
          this._replaceResource();
        }
      }),
    );
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

  override renderBlock() {
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
    // Keep renderer geometry in sync with toolbar style changes before reload.
    this._cardStyle = style;
    // Page follows the shared template; Canvas retains its stored renderer bounds.
    if (!isGfxBlockComponent(this)) this.embedContainerStyle.height = "auto";
    const targets = resolveGitForgeTargets(url);
    const fallbackHost = parseCardUrl(url)?.host ?? "";
    let dateText = "";
    if (createdAt) {
      const date = new Date(createdAt);
      dateText = date.toLocaleDateString(
        this.std.getOptional(EditorI18nProvider)?.locale$.value,
        {
          month: "short",
          day: "numeric",
        },
      );
      const day = date.getDate();
      const suffix =
        ["th", "st", "nd", "rd"][((day / 10) | 0) !== 1 ? day % 10 : 4] || "th";
      dateText = dateText.replace(/\d+/, `${day}${suffix}`);
    }

    // Read reactive state in the mounted block; the host receives plain values
    // and never owns fetching, persisted identity or selection policy.
    return this.renderEmbed(
      () =>
        this.std.get(EditorChromeHostIdentifier).renderGithubCard({
          inSurface: isGfxBlockComponent(this),
          selected: this.selected$.value,
          style,
          family: resolveGitForgeFamily(url),
          host: targets?.host ?? fallbackHost,
          repository: owner || repo ? `${owner}/${repo}` : "",
          date: dateText,
          title,
          description,
          image: image
            ? this.store.get(ImageProxyService).buildUrl(image)
            : null,
          loading: this.loading,
          type: githubType,
          status,
          statusReason,
          assignees,
          open: () => this.open(),
          openAssignee: (assignee) => this._handleAssigneeClick(assignee),
          select: () => {
            if (!this.store.readonly && !isGfxBlockComponent(this))
              this._selectBlock();
          },
        }),
      "native",
    );
  }

  @property({ attribute: false })
  accessor loading = false;
}
