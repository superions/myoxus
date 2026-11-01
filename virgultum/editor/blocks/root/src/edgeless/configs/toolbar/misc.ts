import { getGfxManagedOwner } from "@virgultum/std/gfx";

import { EdgelessFrameManagerIdentifier } from "@virgultum/block-frame";
import {
  EdgelessCRUDIdentifier,
  getSurfaceComponent,
} from "@virgultum/block-surface";
import { ConnectorTool } from "@virgultum/gfx-connector";
import {
  createGroupCommand,
  createGroupFromSelectedCommand,
  ungroupCommand,
} from "@virgultum/gfx-group";
import { Bound } from "@virgultum/global/gfx";
import {
  ConnectorElementModel,
  DEFAULT_CONNECTOR_MODE,
  GroupElementModel,
} from "@virgultum/model";
import {
  ActionPlacement,
  blockCommentToolbarButton,
  type ElementLockEvent,
  type ToolbarAction,
  type ToolbarContext,
  type ToolbarModuleConfig,
  editorMessage,
} from "@virgultum/shared/services";
import {
  batchAddChildren,
  batchRemoveChildren,
  type GfxModel,
} from "@virgultum/std/gfx";

import { alignmentControl } from "./alignment";
import { moreActions } from "./more";

const drawConnectorMessage = editorMessage(
  "com.myoxus.editor.toolbar.draw-connector",
  "Draw connector",
);

export const builtinMiscToolbarConfig = {
  actions: [
    {
      placement: ActionPlacement.Start,
      id: "a.release-from-group",
      tooltip: editorMessage(
        "com.myoxus.editor.toolbar.release-from-group",
        "Release from group",
      ),
      icon: "ReleaseFromGroupIcon",
      when(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length !== 1) return false;
        return ctx.matchModel(models[0].group, GroupElementModel);
      },
      run(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length !== 1) return;

        const firstModel = models[0];
        if (firstModel.isLocked()) return;
        if (!ctx.matchModel(firstModel.group, GroupElementModel)) return;

        const group = firstModel.group;

        batchRemoveChildren(group, [firstModel]);

        firstModel.index = ctx.gfx.layer.generateIndex();

        const parent = group.group;
        if (parent && parent instanceof GroupElementModel) {
          batchAddChildren(parent, [firstModel]);
        }
      },
    },
    {
      placement: ActionPlacement.Start,
      id: "b.add-frame",
      label: editorMessage("com.myoxus.editor.slash.frame", "Frame"),
      showLabel: true,
      tooltip: editorMessage("com.myoxus.editor.slash.frame", "Frame"),
      icon: "FrameIcon",
      when(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length < 2) return false;
        if (models.some((model) => !!getGfxManagedOwner(model))) return false;
        if (
          models.length ===
          models.filter((model) => model instanceof ConnectorElementModel)
            .length
        )
          return false;

        return true;
      },
      run(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length < 2) return;

        const surface = getSurfaceComponent(ctx.std);
        if (!surface) return;

        const frameManager = ctx.std.get(EdgelessFrameManagerIdentifier);

        const frame = frameManager.createFrameOnSelected();
        if (!frame) return;

        // TODO(@fundon): should be a command
        surface.fitToViewport(Bound.deserialize(frame.xywh));

        ctx.track("CanvasElementAdded", {
          control: "context-menu",
          type: "frame",
        });
      },
    },
    {
      placement: ActionPlacement.Start,
      id: "c.add-group",
      label: editorMessage("com.myoxus.keyboardShortcuts.group", "Group"),
      showLabel: true,
      tooltip: editorMessage("com.myoxus.keyboardShortcuts.group", "Group"),
      icon: "GroupingIcon",
      when(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length < 2) return false;
        if (ctx.matchModel(models[0], GroupElementModel)) return false;
        if (models.some((model) => !!getGfxManagedOwner(model))) return false;
        if (
          models.length ===
          models.filter((model) => ctx.matchModel(model, ConnectorElementModel))
            .length
        )
          return false;

        return true;
      },
      run(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length < 2) return;

        // TODO(@fundon): should be a command
        ctx.command.exec(createGroupFromSelectedCommand);
      },
    },
    {
      placement: ActionPlacement.Start,
      id: "d.alignment",
      when(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length < 2) return false;
        if (models.some((model) => !!getGfxManagedOwner(model))) return false;
        if (
          models.length ===
          models.filter((model) => model instanceof ConnectorElementModel)
            .length
        )
          return false;

        return true;
      },
      label: editorMessage(
        "com.myoxus.editor.toolbar.align-objects",
        "Align objects",
      ),
      icon: "AlignLeftIcon",
      control(ctx) {
        const models = ctx.getSurfaceModels();
        return models.length < 2 ? null : alignmentControl(ctx, models);
      },
    },
    {
      placement: ActionPlacement.End,
      id: "a.draw-connector",
      label: drawConnectorMessage,
      tooltip: drawConnectorMessage,
      icon: "ConnectorCIcon",
      when(ctx) {
        const models = ctx.getSurfaceModels();
        if (models.length !== 1) return false;
        return !ctx.matchModel(models[0], ConnectorElementModel);
      },
      run(ctx, _anchor, event) {
        const models = ctx.getSurfaceModels();
        if (!models.length || !event) return;
        event.stopPropagation();
        const point = ctx.gfx.viewport.toViewCoordFromClientCoord([
          event.x,
          event.y,
        ]);
        ctx.store.captureSync();
        ctx.gfx.tool.setTool(ConnectorTool, { mode: DEFAULT_CONNECTOR_MODE });
        ctx.gfx.tool.get(ConnectorTool).quickConnect(point, models[0]);
      },
    } satisfies ToolbarAction,
    {
      placement: ActionPlacement.End,
      id: "b.lock",
      tooltip: editorMessage("com.myoxus.editor.toolbar.lock", "Lock"),
      icon: "LockIcon",
      run(ctx) {
        const models = ctx.getSurfaceModels();
        if (!models.length) return;

        // get most top selected elements(*) from tree, like in a tree below
        //         G0
        //        /  \
        //      E1*  G1
        //          /  \
        //        E2*  E3*
        //
        // (*) selected elements, [E1, E2, E3]
        // return [E1]

        const elements = Array.from(
          new Set(models.map((model) => getGfxManagedOwner(model) ?? model)),
        );

        const levels = elements.map((element) => element.groups.length);
        const topElement = elements[levels.indexOf(Math.min(...levels))];
        const otherElements = elements.filter(
          (element) => element !== topElement,
        );

        ctx.store.captureSync();

        // release other elements from their groups and group with top element
        otherElements.forEach((element) => {
          if (element.group) {
            batchRemoveChildren(element.group, [element]);
          }
          if (topElement.group) {
            batchAddChildren(topElement.group, [element]);
          }
        });

        if (otherElements.length === 0) {
          topElement.lock();

          ctx.gfx.selection.set({
            editing: false,
            elements: [topElement.id],
          });

          track(ctx, topElement, "lock");
          return;
        }

        const [_, { groupId }] = ctx.command.exec(createGroupCommand, {
          elements: [topElement, ...otherElements],
        });

        if (groupId) {
          const element = ctx.std
            .get(EdgelessCRUDIdentifier)
            .getElementById(groupId);

          if (element) {
            element.lock();
            ctx.gfx.selection.set({
              editing: false,
              elements: [groupId],
            });

            track(ctx, element, "group-lock");
            return;
          }
        }

        for (const element of elements) {
          element.lock();

          track(ctx, element, "lock");
        }

        ctx.gfx.selection.set({
          editing: false,
          elements: elements.map((e) => e.id),
        });
      },
    },

    {
      placement: ActionPlacement.End,
      id: "c.comment",
      ...blockCommentToolbarButton,
    },

    // More actions
    ...moreActions.map((action) => ({
      ...action,
      placement: ActionPlacement.More,
    })),
  ],
  when(ctx) {
    const models = ctx.getSurfaceModels();
    return models.length > 0 && !models.some((model) => model.isLocked());
  },
} as const satisfies ToolbarModuleConfig;

export const builtinLockedToolbarConfig = {
  actions: [
    {
      placement: ActionPlacement.End,
      id: "b.unlock",
      label: editorMessage(
        "com.myoxus.editor.toolbar.click-to-unlock",
        "Click to unlock",
      ),
      showLabel: true,
      icon: "UnlockIcon",
      run(ctx) {
        const models = ctx.getSurfaceModels();
        if (!models.length) return;

        const elements = new Set(
          models.map((model) => getGfxManagedOwner(model) ?? model),
        );

        ctx.store.captureSync();

        for (const element of elements) {
          if (element instanceof GroupElementModel) {
            ctx.command.exec(ungroupCommand, { group: element });
          } else {
            element.lockedBySelf = false;
          }

          track(ctx, element, "unlock");
        }
      },
    },
  ],
  when: (ctx) => ctx.getSurfaceModels().some((model) => model.isLocked()),
} as const satisfies ToolbarModuleConfig;

function track(
  ctx: ToolbarContext,
  element: GfxModel,
  control: ElementLockEvent["control"],
) {
  ctx.track("EdgelessElementLocked", {
    control,
    type:
      "type" in element
        ? element.type
        : (element.flavour.split(":")[1] ?? element.flavour),
  });
}
