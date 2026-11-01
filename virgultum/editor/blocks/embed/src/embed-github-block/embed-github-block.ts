import { LoadingIcon, OpenIcon } from "@virgultum/components/icons";
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
import { githubUrlRegex } from "./embed-github-model.js";
import type { EmbedGithubBlockService } from "./embed-github-service.js";
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
    const link = `https://www.github.com/${assignee}`;
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

    if (
      !this.model.props.owner ||
      !this.model.props.repo ||
      !this.model.props.githubId
    ) {
      this.store.withoutTransact(() => {
        const url = this.model.props.url;
        const urlMatch = url.match(githubUrlRegex);
        if (urlMatch) {
          const [, owner, repo, githubType, githubId] = urlMatch;
          this.store.updateBlock(this.model, {
            owner,
            repo,
            githubType: githubType === "issue" ? "issue" : "pr",
            githubId,
          });
        }
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
          this.refreshData();
        }
      }),
    );
  }

  override renderBlock() {
    const {
      title = "GitHub",
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
    const theme = this.std.get(ThemeProvider).theme;
    const imageProxyService = this.store.get(ImageProxyService);
    const { EmbedCardBannerIcon } = getEmbedCardIcons(theme);
    const titleIcon = loading ? LoadingIcon() : GithubIcon;
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
      : title;
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
              githubType === "issue" && assignees
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
              <span class="myoxus-embed-github-content-repo"
                >${`${owner}/${repo} |`}</span
              >

              ${
                createdAt
                  ? html`<span class="myoxus-embed-github-content-date"
                      >${dateText} |</span
                    >`
                  : nothing
              }
              <span>github.com</span>

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
