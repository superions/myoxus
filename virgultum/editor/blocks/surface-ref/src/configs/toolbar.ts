import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  FrameBlockModel,
  GroupElementModel,
  MermaidBlockModel,
} from "@virgultum/model";
import {
  copySelectedModelsCommand,
  draftSelectedModelsCommand,
} from "@virgultum/shared/commands";
import {
  ActionPlacement,
  blockCommentToolbarButton,
  type ToolbarModuleConfig,
  editorMessage,
} from "@virgultum/shared/services";
import { editorToast } from "@virgultum/shared/utils";

import { SurfaceRefBlockComponent } from "../surface-ref-block";

export const surfaceRefToolbarModuleConfig: ToolbarModuleConfig = {
  actions: [
    {
      id: "a.surface-ref-title",
      when: (ctx) =>
        !!ctx.getCurrentBlockByType(SurfaceRefBlockComponent)?.referenceModel,
      generate(ctx) {
        const model = ctx.getCurrentBlockByType(
          SurfaceRefBlockComponent,
        )?.referenceModel;
        if (!model) return null;
        let label = "";
        let icon: MyoxusIconExportName = "EdgelessIcon";
        if (model instanceof MermaidBlockModel) {
          label = model.props.title.toString();
          icon = "WorkflowIcon";
        } else if (model instanceof GroupElementModel) {
          label = model.title.toString();
          icon = "GroupIcon";
        } else if (model instanceof FrameBlockModel) {
          label = model.props.title.toString();
          icon = "FrameIcon";
        }
        return { label, icon, showLabel: true, disabled: true };
      },
    },
    {
      id: "c.copy-surface-ref",
      label: editorMessage("Copy", "Copy"),
      icon: "CopyIcon",
      run: (ctx) => {
        const surfaceRefBlock = ctx.getCurrentBlockByType(
          SurfaceRefBlockComponent,
        );
        if (!surfaceRefBlock) return;

        ctx.chain
          .pipe(draftSelectedModelsCommand, {
            selectedModels: [surfaceRefBlock.model],
          })
          .pipe(copySelectedModelsCommand)
          .run();

        editorToast(
          surfaceRefBlock.std.host,
          editorMessage("Copied to clipboard", "Copied to clipboard"),
        );
      },
    },
    {
      id: "d.surface-ref-caption",
      label: editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
      icon: "CaptionIcon",
      run: (ctx) => {
        const surfaceRefBlock = ctx.getCurrentBlockByType(
          SurfaceRefBlockComponent,
        );
        if (!surfaceRefBlock) return;

        surfaceRefBlock.captionElement.show();
      },
    },
    {
      id: "e.comment",
      ...blockCommentToolbarButton,
    },
    {
      id: "a.clipboard",
      placement: ActionPlacement.More,
      when: (ctx) => {
        const surfaceRefBlock = ctx.getCurrentBlock();
        if (!(surfaceRefBlock instanceof SurfaceRefBlockComponent))
          return false;

        return !!surfaceRefBlock.referenceModel;
      },
      actions: [
        // TODO(@L-Sun): add duplicate action after refactoring root-block/edgeless
      ],
    },
    {
      id: "g.surface-ref-deletion",
      label: editorMessage("Delete", "Delete"),
      icon: "DeleteIcon",
      placement: ActionPlacement.More,
      variant: "destructive",
      run: (ctx) => {
        const surfaceRefBlock = ctx.getCurrentBlockByType(
          SurfaceRefBlockComponent,
        );
        if (!surfaceRefBlock) return;

        ctx.store.deleteBlock(surfaceRefBlock.model);
      },
    },
  ],
  placement: "inner",
};
