import { CodeIcon, LoadingIcon, OpenIcon } from "@virgultum/components/icons";
import type { EmbedGithubModel, EmbedGithubStyles } from "@virgultum/model";
import { ImageProxyService } from "@virgultum/shared/adapters";
import {
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { BlockSelection, isGfxBlockComponent } from "@virgultum/std";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";

import { EmbedBlockComponent } from "../common/embed-block-element.js";
import { getEmbedCardIcons } from "../common/utils.js";
import type { EmbedGithubBlockService } from "./embed-github-service.js";
import {
  parseCardUrl,
  parseGitForgeUrl,
  resolveGitForgeFamily,
  resolveGitForgeTargets,
} from "./git-forge.js";
import { GithubIcon, styles } from "./styles.js";
import {
  getGithubStatusIcon,
  refreshEmbedGithubStatus,
  refreshEmbedGithubUrlData,
} from "./utils.js";

export class EmbedGithubBlockComponent extends EmbedBlockComponent<
  EmbedGithubModel,
  EmbedGithubBlockService
> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = styles;

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

  private _handleDoubleClick(event: MouseEvent) {
    event.stopPropagation();
    this.open();
  }

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  protected _handleClick(event: MouseEvent) {
    event.stopPropagation();
    this._selectBlock();
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
    } = this.model.props;

    const loading = this.loading;
    const targets = resolveGitForgeTargets(this.model.props.url);
    // GitHub keeps its icon; the new families reuse `CodeIcon`. A non-forge
    // URL (fallback card) keeps the baseline GitHub icon.
    const family = resolveGitForgeFamily(this.model.props.url);
    // An unsupported URL keeps a usable original link: the actual URL host
    // is the title/footer fallback instead of inventing a GitHub target,
    // and a missing identity shows no repository at all.
    const fallbackHost = parseCardUrl(this.model.props.url)?.host ?? null;
    const fallbackTitle =
      family === "GitHub" ? "GitHub" : (fallbackHost ?? "GitHub");
    const theme = this.std.get(ThemeProvider).theme;
    const imageProxyService = this.store.get(ImageProxyService);
    const { EmbedCardBannerIcon } = getEmbedCardIcons(theme);
    const titleIcon = loading
      ? LoadingIcon()
      : family === "GitLab" || family === "Forgejo/Gitea"
        ? CodeIcon
        : GithubIcon;
    // GitHub keeps its current behavior (assignees only for issues). The new
    // families report assignees for both issues and merge/pull requests.
    const isGitForgeFamily = family === "GitLab" || family === "Forgejo/Gitea";
    const showAssignees =
      assignees && (githubType === "issue" || isGitForgeFamily);
    const statusIcon = status
      ? getGithubStatusIcon(githubType, status, statusReason)
      : nothing;
    const statusLabels: Record<string, EditorI18nMessage> = {
      open: editorMessage("com.myoxus.editor.github.open", "Open"),
      closed: editorMessage("com.myoxus.editor.github.closed", "Closed"),
      merged: editorMessage("com.myoxus.editor.github.merged", "Merged"),
      draft: editorMessage(
        "com.myoxus.workspace-content-operation.status.draft",
        "Draft",
      ),
    };
    const statusText =
      loading || !status
        ? ""
        : statusLabels[status]
          ? this._text(statusLabels[status])
          : status;
    const titleText = loading
      ? this._text(editorMessage("com.myoxus.loading", "Loading"))
      : (title ?? fallbackTitle);
    const descriptionText = loading ? "" : description;
    const bannerImage =
      !loading && image
        ? html`<img src=${imageProxyService.buildUrl(image)} alt="banner" />`
        : EmbedCardBannerIcon;

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

    return this.renderEmbed(
      () => html`
        <div
          class=${classMap({
            "myoxus-embed-github-block": true,
            loading,
            [style]: true,
            edgeless: isGfxBlockComponent(this),
            selected: this.selected$.value,
          })}
          style=${styleMap({
            // transform: `scale(${this._scale})`,
            transformOrigin: "0 0 ",
          })}
          @click=${this._handleClick}
          @dblclick=${this._handleDoubleClick}
        >
          <div class="myoxus-embed-github-content">
            <div class="myoxus-embed-github-content-title">
              <div class="myoxus-embed-github-content-title-icons">
                <div class="myoxus-embed-github-content-title-site-icon">
                  ${titleIcon}
                </div>

                ${
                  status && statusText
                    ? html`<div
                        class=${classMap({
                          "myoxus-embed-github-content-title-status-icon": true,
                          [githubType]: true,
                          [status]: true,
                          success: statusReason === "completed",
                          failure: statusReason === "not_planned",
                        })}
                      >
                        ${statusIcon}

                        <span>${statusText}</span>
                      </div>`
                    : nothing
                }
              </div>

              <div class="myoxus-embed-github-content-title-text">
                ${titleText}
              </div>
            </div>

            <div class="myoxus-embed-github-content-description">
              ${descriptionText}
            </div>

            ${
              showAssignees
                ? html`
                    <div class="myoxus-embed-github-content-assignees">
                      <div
                        class="myoxus-embed-github-content-assignees-text label"
                      >
                        ${this._text(editorMessage("com.myoxus.editor.embed.assignees", "Assignees"))}
                      </div>

                      <div
                        class="myoxus-embed-github-content-assignees-text users"
                      >
                        ${
                          assignees.length === 0
                            ? html`<span
                                class="myoxus-embed-github-content-assignees-text-users placeholder"
                                >${this._text(editorMessage("com.myoxus.editor.embed.no-assignees", "No assignees"))}</span
                              >`
                            : repeat(
                                assignees,
                                (assignee) => assignee,
                                (assignee, index) =>
                                  html`<span
                                      class="myoxus-embed-github-content-assignees-text-users user"
                                      @click=${() =>
                                        this._handleAssigneeClick(assignee)}
                                      >${`@${assignee}`}</span
                                    >
                                    ${index === assignees.length - 1 ? "" : `, `}`,
                              )
                        }
                      </div>
                    </div>
                  `
                : nothing
            }

            <div class="myoxus-embed-github-content-url" @click=${this.open}>
              ${
                owner || repo
                  ? html`<span class="myoxus-embed-github-content-repo"
                      >${`${owner}/${repo} |`}</span
                    >`
                  : nothing
              }
              ${
                createdAt
                  ? html`<span class="myoxus-embed-github-content-date"
                      >${dateText} |</span
                    >`
                  : nothing
              }
              <span>${targets?.host ?? fallbackHost ?? ""}</span>

              <div class="myoxus-embed-github-content-url-icon">
                ${OpenIcon}
              </div>
            </div>
          </div>
          <div class="myoxus-embed-github-banner">${bannerImage}</div>
        </div>
      `,
    );
  }

  @property({ attribute: false })
  accessor loading = false;
}
