// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { copyTextToClipboard } from "@virgultum/global/utils";
import { createOpenDocActions } from "./text-actions";

import { snapshotTaskCaptureSelection } from "./task-capture-selection";
import {
  generateUrl,
  type UseSharingUrl,
} from "@myoxus/core/components/hooks/myoxus/use-share-url";
import { EditorService } from "@myoxus/core/modules/editor";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { copyLinkToBlockStdScopeClipboard } from "@myoxus/core/utils/clipboard";
import { I18n, i18nTime } from "@myoxus/i18n";
import { LinkIcon } from "@myoxus/icons/lit";
import type { FrameworkProvider } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { computed } from "@preact/signals-core";
import { BookmarkBlockComponent } from "@virgultum/editor/blocks/bookmark";
import {
  EmbedFigmaBlockComponent,
  EmbedGithubBlockComponent,
  EmbedIframeBlockComponent,
  EmbedLoomBlockComponent,
  EmbedYoutubeBlockComponent,
  getDocContentWithMaxLength,
} from "@virgultum/editor/blocks/embed";
import { EmbedLinkedDocBlockComponent } from "@virgultum/editor/blocks/embed-doc";
import { SurfaceRefBlockComponent } from "@virgultum/editor/blocks/surface-ref";
import { toggleEmbedCardEditModal } from "@virgultum/editor/components/embed-card-modal";
import { notifyLinkedDocClearedAliases } from "@virgultum/editor/components/notification";
import {
  type MenuContext,
  type AdvancedMenuItem,
} from "@virgultum/editor/components/toolbar";
import {
  BookmarkBlockModel,
  EmbedIframeBlockModel,
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
} from "@virgultum/editor/model";
import { getSelectedModelsCommand } from "@virgultum/editor/shared/commands";
import { ImageSelection } from "@virgultum/editor/shared/selection";
import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorText,
  type SelectionAction,
  ActionPlacement,
  CitationProvider,
  GenerateDocUrlProvider,
  isRemovedUserInfo,
  type ToolbarContext,
  type ToolbarModuleConfig,
  UserProvider,
} from "@virgultum/editor/shared/services";
import { matchModels } from "@virgultum/editor/shared/utils";
import { BlockSelection, TextSelection } from "@virgultum/editor/std";
import {
  GfxBlockElementModel,
  GfxPrimitiveElementModel,
} from "@virgultum/editor/std/gfx";
import { editorToast } from "@virgultum/shared/utils";
import { copyAsImage, createCopyAsPngMenuItem } from "./copy-as-image";
import {
  createTaskToolbarActions,
  taskCaptureModels,
  openTaskCapture,
} from "./task-template-actions";
export function createToolbarMoreMenuConfig(framework: FrameworkProvider) {
  return {
    actions: (ctx: MenuContext): SelectionAction[] => {
      const items: [AdvancedMenuItem<MenuContext>, SelectionAction["icon"]][] =
        [
          [createCopyAsPngMenuItem(framework), "CopyAsImgaeIcon"],
          [createCopyLinkToBlockMenuItem(framework), "LinkIcon"],
          [
            {
              type: "capture-as-task",
              label: editorMessage(
                "com.myoxus.database.tasks.capture",
                "Capture as Task",
              ),
              when: () =>
                !ctx.doc.readonly &&
                Boolean(
                  snapshotTaskCaptureSelection(
                    ctx.std,
                    ctx.selectedBlockModels,
                  ),
                ),
              action: () => {
                if (
                  ctx.doc.readonly ||
                  !snapshotTaskCaptureSelection(
                    ctx.std,
                    ctx.selectedBlockModels,
                  )
                )
                  return;
                void openTaskCapture(
                  framework,
                  ctx.std,
                  ctx.selectedBlockModels,
                );
                ctx.close();
              },
            },
            "CopyIcon",
          ],
        ];
      return items.flatMap(([item, icon]) =>
        item.when && !item.when(ctx)
          ? []
          : [
              {
                id: item.type,
                label:
                  resolveEditorText(
                    item.label,
                    ctx.std.getOptional(EditorI18nProvider) ?? undefined,
                  ) ?? item.type,
                icon,
                disabled: false,
                run: () => {
                  void item.action?.(ctx);
                },
              },
            ],
      );
    },
  };
}

function createCopyLinkToBlockMenuItem(
  framework: FrameworkProvider,
  item = {
    icon: LinkIcon({ width: "20", height: "20" }),
    label: editorMessage(
      "com.myoxus.editor.toolbar.copy-link-to-block",
      "Copy link to block",
    ),
    type: "copy-link-to-block",
    when: (ctx: MenuContext) => {
      if (ctx.isEmpty()) return false;

      const { editor } = framework.get(EditorService);
      const mode = editor.mode$.value;

      if (mode === "edgeless") {
        // linking blocks in notes is currently not supported in edgeless mode.
        if (ctx.selectedBlockModels.length > 0) {
          return false;
        }

        // linking single block/element in edgeless mode.
        if (ctx.isMultiple()) {
          return false;
        }
      }

      return true;
    },
  },
) {
  return {
    ...item,
    action: async (ctx: MenuContext) => {
      const workspaceServerService = framework.get(WorkspaceServerService);

      const { editor } = framework.get(EditorService);
      const mode = editor.mode$.value;
      const pageId = editor.doc.id;
      const workspaceId = editor.doc.workspace.id;
      const options: UseSharingUrl = { workspaceId, pageId, mode };
      let type = "";

      if (mode === "page") {
        // maybe multiple blocks
        const blockIds = ctx.selectedBlockModels.map((model) => model.id);
        options.blockIds = blockIds;
        type = ctx.selectedBlockModels[0].flavour;
      } else if (mode === "edgeless" && ctx.firstElement) {
        // single block/element
        const id = ctx.firstElement.id;
        if (ctx.isElement()) {
          options.elementIds = [id];
          type = (ctx.firstElement as GfxPrimitiveElementModel).type;
        } else {
          options.blockIds = [id];
          type = (ctx.firstElement as GfxBlockElementModel).flavour;
        }
      }

      const str = generateUrl({
        ...options,
        baseUrl: workspaceServerService.server?.baseUrl ?? location.origin,
      });
      if (!str) {
        ctx.close();
        return;
      }

      const success = await copyLinkToBlockStdScopeClipboard(
        str,
        ctx.std.clipboard,
      );

      if (success) {
        notify.success({ title: I18n["Copied link to clipboard"]() });
      }

      track.doc.editor.toolbar.copyBlockToLink({ type });

      ctx.close();
    },
  };
}

export function createToolbarMoreMenuConfigV2(
  baseUrl?: string,
  framework?: FrameworkProvider,
) {
  const { captureAction, insertExistingAction } =
    createTaskToolbarActions(framework);
  return {
    readonlyTextSelection: (std) => {
      const selectedModels = taskCaptureModels(std);
      if (!framework || !snapshotTaskCaptureSelection(std, selectedModels))
        return null;
      return [
        {
          id: "a.clipboard",
          placement: ActionPlacement.More,
          actions: [captureAction],
        },
      ];
    },
    actions: [
      {
        placement: ActionPlacement.More,
        id: "a.clipboard",
        actions: [
          captureAction,
          insertExistingAction,
          {
            id: "copy-as-image",
            label: editorMessage(
              "com.myoxus.editor.toolbar.copy-as-image",
              "Copy as Image",
            ),
            icon: "CopyAsImgaeIcon",
            when: ({ isEdgelessMode, gfx, flags }) =>
              !flags.isHovering() &&
              isEdgelessMode &&
              gfx.selection.selectedElements.length > 0,
            run: ({ std }) => {
              copyAsImage(std);
            },
          },
          {
            id: "copy-link-to-block",
            label: editorMessage(
              "com.myoxus.editor.toolbar.copy-link-to-block",
              "Copy link to block",
            ),
            icon: "LinkIcon",
            when: ({ isPageMode, selection, gfx, flags }) => {
              if (flags.isHovering()) return false;

              const items = selection
                .getGroup("note")
                .filter((item) =>
                  [TextSelection, BlockSelection, ImageSelection].some((t) =>
                    item.is(t),
                  ),
                );
              const hasNoteSelection = items.length > 0;

              if (isPageMode) {
                const item = items[0];
                if (item && item.is(TextSelection)) {
                  return (
                    !item.isCollapsed() &&
                    Boolean(item.from.length + (item.to?.length ?? 0))
                  );
                }
                return hasNoteSelection;
              }

              // Linking blocks in notes is currently not supported under edgeless.
              if (hasNoteSelection) return false;

              // Linking single block/element in edgeless mode.
              return gfx.selection.selectedElements.length === 1;
            },
            run({ isPageMode, std, store, gfx, workspace, editorMode }) {
              const pageId = store.doc.id;
              const mode = editorMode;
              const workspaceId = workspace.id;
              const options: UseSharingUrl = { workspaceId, pageId, mode };
              let type = "";

              if (isPageMode) {
                const [ok, { selectedModels = [] }] = std.command.exec(
                  getSelectedModelsCommand,
                );

                if (!ok || !selectedModels.length) return;

                options.blockIds = selectedModels.map((model) => model.id);
                type = selectedModels[0].flavour;
              } else {
                const firstElement = gfx.selection.firstElement;
                if (!firstElement) return;

                const ids = [firstElement.id];
                if (firstElement instanceof GfxPrimitiveElementModel) {
                  type = firstElement.type;
                  options.elementIds = ids;
                } else if (firstElement instanceof GfxBlockElementModel) {
                  type = firstElement.flavour;
                  options.blockIds = ids;
                }
              }

              if (!type) return;

              const str = generateUrl({
                ...options,
                baseUrl: baseUrl ?? location.origin,
              });

              if (!str) return;

              copyLinkToBlockStdScopeClipboard(str, std.clipboard)
                .then((ok) => {
                  if (!ok) return;

                  notify.success({ title: I18n["Copied link to clipboard"]() });
                })
                .catch(console.error);

              track.doc.editor.toolbar.copyBlockToLink({ type });
            },
          },
        ],
      },
      {
        placement: ActionPlacement.More,
        id: "z.block-meta",
        actions: [
          {
            id: "block-meta-display",
            when: (ctx) => {
              const isEnabled = ctx.features.getFlag("enable_block_meta");
              if (!isEnabled) return false;

              // only display when one block is selected by block selection
              const hasBlockSelection =
                ctx.selection.filter(BlockSelection).length === 1;
              if (!hasBlockSelection) return false;
              const model = ctx.getCurrentModelBy(BlockSelection);
              if (!model) return false;

              const createdAt = "meta:createdAt";
              const createdBy = "meta:createdBy";
              return (
                "props" in model &&
                createdAt in model.props &&
                model.props[createdAt] !== undefined &&
                createdBy in model.props &&
                model.props[createdBy] !== undefined &&
                typeof model.props[createdBy] === "string" &&
                typeof model.props[createdAt] === "number"
              );
            },
            generate: (ctx) => {
              const model = ctx.getCurrentModelBy(BlockSelection);
              if (!model) return null;
              if (!("props" in model)) return null;
              const createdAt = "meta:createdAt";
              if (!(createdAt in model.props)) return null;
              const createdBy = "meta:createdBy";
              if (!(createdBy in model.props)) return null;
              const createdByUserId = model.props[createdBy];
              const createdAtTimestamp = model.props[createdAt];
              // Imported/native blocks may lack authoring metadata. Generators
              // can be evaluated before `when`; never invent a date or request
              // an undefined user just because schema keys are present.
              if (
                typeof createdByUserId !== "string" ||
                !createdByUserId ||
                typeof createdAtTimestamp !== "number" ||
                !Number.isFinite(createdAtTimestamp)
              )
                return null;
              const date = new Date(createdAtTimestamp);
              if (!Number.isFinite(date.getTime())) return null;
              const userProvider = ctx.std.getOptional(UserProvider);
              if (!userProvider) return null;
              userProvider.revalidateUserInfo(createdByUserId);
              const userSignal = userProvider.userInfo$(createdByUserId);
              const isLoadingSignal = userProvider.isLoading$(createdByUserId);
              const name = computed(() => {
                const value = userSignal.value;
                if (!value) {
                  if (isLoadingSignal.value) {
                    // if user info is loading
                    return "";
                  }
                  return I18n["Unknown User"]();
                }
                const removed = isRemovedUserInfo(value);
                if (removed) {
                  return I18n["Deleted User"]();
                }
                return value.name;
              });
              const user = computed(() => {
                return I18n.t("com.myoxus.page.toolbar.created_by", {
                  name: name.value,
                });
              });
              const createdAtString = i18nTime(date.toISOString(), {
                absolute: {
                  accuracy: "minute",
                },
              });
              return {
                label: `${user.value} · ${createdAtString}`,
                disabled: true,
                showLabel: true,
              };
            },
          },
        ],
      },
    ],

    when: (ctx) => !ctx.getSurfaceModels().some((model) => model.isLocked()),
  } as const satisfies ToolbarModuleConfig;
}

export function createExternalLinkableToolbarConfig(
  klass:
    | typeof BookmarkBlockComponent
    | typeof EmbedFigmaBlockComponent
    | typeof EmbedGithubBlockComponent
    | typeof EmbedLoomBlockComponent
    | typeof EmbedYoutubeBlockComponent,
) {
  return {
    actions: [
      {
        id: "a.copy-link",
        tooltip: editorMessage(
          "com.myoxus.editor.toolbar.copy-link",
          "Copy link",
        ),
        icon: "CopyIcon",
        async run(ctx) {
          const model = ctx.getCurrentBlockByType(klass)?.model;
          if (!model) return;

          const { url } = model.props;

          if (!(await copyTextToClipboard(url))) return;
          editorToast(
            ctx.host,
            editorMessage(
              "Copied link to clipboard",
              "Copied link to clipboard",
            ),
          );

          ctx.track("CopiedLink", {
            category: matchModels(model, [BookmarkBlockModel])
              ? "bookmark"
              : "link",
            type: "card view",
            control: "copy link",
          });
        },
      },
      {
        id: "a.preview.after.copy-link-and-edit",
        actions: [
          {
            id: "edit",
            tooltip: editorMessage(
              "com.myoxus.editor.toolbar.edit-description",
              "Edit Description",
            ),
            icon: "EditIcon",
            run(ctx) {
              const block = ctx.getCurrentBlockByType(klass);
              if (!block) return;

              ctx.hide();

              const model = block.model;
              const abortController = new AbortController();
              abortController.signal.onabort = () => ctx.show();

              toggleEmbedCardEditModal(
                ctx.host,
                model,
                "card",
                undefined,
                undefined,
                (_std, _component, props) => {
                  ctx.store.updateBlock(model, props);
                  block.requestUpdate();
                  const citationService = ctx.std.get(CitationProvider);
                  if (citationService.isCitationModel(model)) {
                    citationService.trackEvent("Edit");
                  }
                },
                abortController,
              );

              ctx.track("OpenedAliasPopup", {
                category: matchModels(model, [BookmarkBlockModel])
                  ? "bookmark"
                  : "link",
                type: "card view",
                control: "edit",
              });
            },
          },
        ],
      },
    ],
  } as const satisfies ToolbarModuleConfig;
}

export function createSurfaceRefToolbarConfig(
  baseUrl?: string,
): ToolbarModuleConfig {
  return {
    actions: [
      {
        id: "b.open-surface-ref",
        when: (ctx) =>
          !!ctx.getCurrentBlockByType(SurfaceRefBlockComponent)?.referenceModel,
        label: editorMessage("com.myoxus.editor.toolbar.open-doc", "Open doc"),
        icon: "OpenInNewIcon",
        control: (ctx) => {
          const surfaceRefBlock = ctx.getCurrentBlockByType(
            SurfaceRefBlockComponent,
          );
          if (!surfaceRefBlock) return null;

          const actions = createOpenDocActions(ctx, surfaceRefBlock, false)
            .map(({ generate, ...action }) => ({ ...action, ...generate(ctx) }))
            .map((action) => {
              if (action.id.endsWith("open-in-active-view")) {
                action.label = editorMessage(
                  "com.myoxus.peek-view-controls.open-doc-in-edgeless",
                  "Open in edgeless",
                );
              }
              return action;
            });
          if (!actions.length) return null;

          return { type: "menu", items: actions };
        },
      },
      {
        id: "a.clipboard",
        placement: ActionPlacement.More,
        actions: [
          {
            id: "copy-link-to-surface-ref",
            label: editorMessage(
              "com.myoxus.editor.toolbar.copy-original-link",
              "Copy original link",
            ),
            icon: "LinkIcon",
            when: (ctx) =>
              !!ctx.getCurrentBlockByType(SurfaceRefBlockComponent)
                ?.referenceModel,
            run: (ctx) => {
              const surfaceRefBlock = ctx.getCurrentBlockByType(
                SurfaceRefBlockComponent,
              );
              if (!surfaceRefBlock) return;

              const refModel = surfaceRefBlock.referenceModel;
              if (!refModel) return;

              const { store, workspace, std } = ctx;
              const pageId = store.doc.id;
              const workspaceId = workspace.id;
              const options: UseSharingUrl = {
                workspaceId,
                pageId,
                mode: "edgeless",
              };

              let type = "";
              if (refModel instanceof GfxPrimitiveElementModel) {
                options.elementIds = [refModel.id];
                type = refModel.type;
              } else if (refModel instanceof GfxBlockElementModel) {
                options.blockIds = [refModel.id];
                type = refModel.flavour;
              }

              const str = generateUrl({
                ...options,
                baseUrl: baseUrl ?? location.origin,
              });
              if (!str) return;

              copyLinkToBlockStdScopeClipboard(str, std.clipboard)
                .then((ok) => {
                  if (!ok) return;

                  notify.success({ title: I18n["Copied link to clipboard"]() });
                })
                .catch(console.error);

              track.doc.editor.toolbar.copyBlockToLink({ type });
            },
          },
        ],
      },
    ],

    when: (ctx) => ctx.isPageMode,
  };
}

export const embedLinkedDocToolbarConfig = {
  actions: [
    {
      id: "a.doc-title.after.copy-link",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.copy-link",
        "Copy link",
      ),
      icon: "CopyIcon",
      async run(ctx) {
        const model = ctx.getCurrentModelByType(EmbedLinkedDocModel);
        if (!model) return;

        const { pageId, params } = model.props;

        const url = ctx.std
          .getOptional(GenerateDocUrlProvider)
          ?.generateDocUrl(pageId, params);

        if (!url) return;

        if (!(await copyTextToClipboard(url))) return;
        editorToast(
          ctx.host,
          editorMessage("Copied link to clipboard", "Copied link to clipboard"),
        );

        ctx.track("CopiedLink", {
          category: "linked doc",
          type: "card view",
          control: "copy link",
        });
      },
    },
    {
      id: "c.edit-alias",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.edit-description",
        "Edit Description",
      ),
      icon: "EditIcon",
      run(ctx) {
        const block = ctx.getCurrentBlockByType(EmbedLinkedDocBlockComponent);
        if (!block) return;

        ctx.hide();

        const model = block.model;
        const doc = ctx.workspace.getDoc(model.props.pageId)?.getStore();
        const abortController = new AbortController();
        abortController.signal.onabort = () => ctx.show();

        toggleEmbedCardEditModal(
          ctx.host,
          model,
          "card",
          doc
            ? {
                title: doc.meta?.title,
                description: getDocContentWithMaxLength(doc),
              }
            : undefined,
          (std) => {
            block.refreshData();
            notifyLinkedDocClearedAliases(std);
          },
          (_std, _component, props) => {
            ctx.store.updateBlock(model, props);
            block.requestUpdate();
            const citationService = ctx.std.get(CitationProvider);
            if (citationService.isCitationModel(model)) {
              citationService.trackEvent("Edit");
            }
          },
          abortController,
        );

        ctx.track("OpenedAliasPopup", {
          category: "linked doc",
          type: "embed view",
          control: "edit",
        });
      },
    },
  ],
} as const satisfies ToolbarModuleConfig;

export const embedSyncedDocToolbarConfig = {
  actions: [
    {
      placement: ActionPlacement.Start,
      id: "B.copy-link-and-edit",
      actions: [
        {
          id: "copy-link",
          tooltip: editorMessage(
            "com.myoxus.editor.toolbar.copy-link",
            "Copy link",
          ),
          icon: "CopyIcon",
          async run(ctx) {
            const model = ctx.getCurrentModelByType(EmbedSyncedDocModel);
            if (!model) return;

            const { pageId, params } = model.props;

            const url = ctx.std
              .getOptional(GenerateDocUrlProvider)
              ?.generateDocUrl(pageId, params);

            if (!url) return;

            if (!(await copyTextToClipboard(url))) return;
            editorToast(
              ctx.host,
              editorMessage(
                "Copied link to clipboard",
                "Copied link to clipboard",
              ),
            );

            ctx.track("CopiedLink", {
              category: "linked doc",
              type: "embed view",
              control: "copy link",
            });
          },
        },
      ],
    },
  ],
} as const satisfies ToolbarModuleConfig;

export const embedIframeToolbarConfig = {
  when: (ctx: ToolbarContext) => {
    const model = ctx.getCurrentModelByType(EmbedIframeBlockModel);
    if (!model) return false;

    return !!model.props.url;
  },
  actions: [
    {
      id: "b.copy-link",
      actions: [
        {
          id: "copy-link",
          tooltip: editorMessage(
            "com.myoxus.editor.toolbar.copy-original-link",
            "Copy original link",
          ),
          icon: "CopyIcon",
          async run(ctx) {
            const model = ctx.getCurrentBlockByType(
              EmbedIframeBlockComponent,
            )?.model;
            if (!model) return;

            const { url } = model.props;

            if (!(await copyTextToClipboard(url))) return;
            editorToast(
              ctx.host,
              editorMessage(
                "Copied link to clipboard",
                "Copied link to clipboard",
              ),
            );

            ctx.track("CopiedLink", {
              category: matchModels(model, [EmbedIframeBlockModel])
                ? "embed iframe block"
                : "link",
              type: "card view",
              control: "copy link",
            });
          },
        },
      ],
    },
  ],
} as const satisfies ToolbarModuleConfig;
