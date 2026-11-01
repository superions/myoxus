// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { copyTextToClipboard } from "@virgultum/global/utils";

import type { EditorSettingExt } from "@myoxus/core/modules/editor-setting/entities/editor-setting";
import { computed } from "@preact/signals-core";
import {
  EmbedLinkedDocBlockComponent,
  EmbedSyncedDocBlockComponent,
} from "@virgultum/editor/blocks/embed-doc";
import { SurfaceRefBlockComponent } from "@virgultum/editor/blocks/surface-ref";
import { isPeekable, peek } from "@virgultum/editor/components/peek";
import { MyoxusReference } from "@virgultum/editor/inlines/reference";
import {
  editorMessage,
  ActionPlacement,
  GenerateDocUrlProvider,
  OpenDocExtensionIdentifier,
  type OpenDocMode,
  type ToolbarActions,
  type ToolbarActionGenerator,
  type ToolbarActionGroupGenerator,
  type ToolbarContext,
  type ToolbarModuleConfig,
} from "@virgultum/editor/shared/services";
import { editorToast } from "@virgultum/shared/utils";
import { openDocActions } from "../../editor-view/open-doc";

export function createOpenDocActions(
  ctx: ToolbarContext,
  target:
    | EmbedLinkedDocBlockComponent
    | EmbedSyncedDocBlockComponent
    | MyoxusReference
    | SurfaceRefBlockComponent,
  isSameDoc: boolean,
  actions = openDocActions.map(
    ({ type: mode, label, iconName: icon, enabled: when, shortcut }, i) => ({
      mode,
      id: `${i}.${mode}`,
      label,
      icon,
      when,
      shortcut,
    }),
  ),
) {
  return actions
    .filter((action) => action.when)
    .map<ToolbarActionGenerator & { mode: OpenDocMode; shortcut?: string }>(
      (action) => {
        const openMode = action.mode;
        const shouldOpenInCenterPeek = openMode === "open-in-center-peek";
        const shouldOpenInActiveView = openMode === "open-in-active-view";

        return {
          ...action,
          generate(ctx) {
            const disabled = shouldOpenInActiveView ? isSameDoc : false;

            const when =
              ctx.std.get(OpenDocExtensionIdentifier).isAllowed(openMode) &&
              (shouldOpenInCenterPeek ? isPeekable(target) : true);

            const run = shouldOpenInCenterPeek
              ? (_ctx: ToolbarContext) => peek(target)
              : (_ctx: ToolbarContext) => target.open({ openMode });

            return { disabled, when, run };
          },
        };
      },
    )
    .filter((action) => {
      if (typeof action.when === "function") return action.when(ctx);
      return action.when ?? true;
    });
}

export function createOpenDocActionGroup(
  klass:
    typeof EmbedLinkedDocBlockComponent | typeof EmbedSyncedDocBlockComponent,
  settings: EditorSettingExt,
): ToolbarActionGroupGenerator {
  return {
    placement: ActionPlacement.Start,
    id: "A.open-doc",
    generate(ctx) {
      const block = ctx.getCurrentBlockByType(klass);
      if (!block) return null;

      return {
        actions: resolveOpenDocControls(
          settings,
          ctx,
          block,
          block.model.props.pageId === ctx.store.id,
        ),
      };
    },
  };
}

export function createEdgelessOpenDocActionGroup(
  klass:
    typeof EmbedLinkedDocBlockComponent | typeof EmbedSyncedDocBlockComponent,
): ToolbarActionGroupGenerator {
  return {
    placement: ActionPlacement.More,
    id: "Z.c.open-doc",
    generate(ctx) {
      const block = ctx.getCurrentBlockByType(klass);
      if (!block) return null;

      const actions = createOpenDocActions(
        ctx,
        block,
        block.model.props.pageId === ctx.store.id,
      ).map(({ generate, ...action }) => ({ ...action, ...generate(ctx) }));

      return { actions };
    },
  };
}

function resolveOpenDocControls(
  settings: EditorSettingExt,
  ctx: ToolbarContext,
  target:
    | EmbedLinkedDocBlockComponent
    | EmbedSyncedDocBlockComponent
    | MyoxusReference,
  isSameDoc: boolean,
): ToolbarActions {
  // A resolved entry must not regenerate and replace its preference callback.
  const actions = createOpenDocActions(ctx, target, isSameDoc).map(
    ({ generate, ...action }) => ({
      ...action,
      ...generate(ctx),
    }),
  );
  if (!actions.length) return [];

  const openDocMode = computed(
    () => settings.settingSignal.value.openDocMode ?? "open-in-active-view",
  );
  const updateOpenDocMode = (mode: OpenDocMode) =>
    settings.openDocMode.set(mode);

  const current =
    actions.find((action) => action.mode === openDocMode.value) ?? actions[0];
  return [
    {
      ...current,
      id: "primary",
      label: editorMessage(
        "com.myoxus.editor.edgeless-embed-synced-doc-header.open",
        "Open",
      ),
      tooltip: current.label,
      showLabel: true,
    },
    {
      id: "modes",
      icon: "ArrowDownSmallIcon",
      label: editorMessage(
        "com.myoxus.editor.toolbar.open-with",
        "Open doc with",
      ),
      control: {
        type: "menu",
        items: actions.map((action) => ({
          ...action,
          run: (cx) => {
            action.run?.(cx);
            updateOpenDocMode(action.mode);
          },
        })),
      },
    },
  ];
}

const inlineReferenceToolbarConfig = {
  actions: [
    {
      id: "b.copy-link-and-edit",
      actions: [
        {
          id: "copy-link",
          tooltip: editorMessage(
            "com.myoxus.editor.toolbar.copy-link",
            "Copy link",
          ),
          icon: "CopyIcon",
          async run(ctx) {
            const target = ctx.message$.peek()?.element;
            if (!(target instanceof MyoxusReference)) return;

            const { pageId, params } = target.referenceInfo;

            const url = ctx.std
              .getOptional(GenerateDocUrlProvider)
              ?.generateDocUrl(pageId, params);

            if (!url) return;

            // Clears
            ctx.reset();

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
              type: "inline view",
              control: "copy link",
            });
          },
        },
      ],
    },
  ],
} as const satisfies ToolbarModuleConfig;

export function createInlineReferenceToolbarConfig(settings: EditorSettingExt) {
  return {
    actions: [
      {
        placement: ActionPlacement.Start,
        id: "A.open-doc",
        generate(ctx) {
          const target = ctx.message$.peek()?.element;
          if (!(target instanceof MyoxusReference)) return null;

          return {
            actions: resolveOpenDocControls(
              settings,
              ctx,
              target,
              target.referenceInfo.pageId === ctx.store.id,
            ),
          };
        },
      } as const satisfies ToolbarActionGroupGenerator,
      inlineReferenceToolbarConfig.actions,
    ].flat(),
  };
}
