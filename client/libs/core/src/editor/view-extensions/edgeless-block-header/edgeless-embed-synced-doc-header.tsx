import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { stopPropagation } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  CenterPeekIcon,
  ExpandFullIcon,
  LinkedPageIcon,
  OpenInNewIcon,
  SplitViewIcon,
  ToggleDownIcon,
  ToggleRightIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  CanvasOverlayTitleIcon,
  CanvasOverlayTitleSlot,
  CanvasOverlayTitleText,
  CanvasOverlayToolbar,
  IconButton,
  Menu,
  MenuItem,
} from "@myoxus/ui-facade";
import { batch } from "@preact/signals-core";
import { EmbedSyncedDocBlockComponent } from "@virgultum/editor/blocks/embed-doc";
import { isPeekable, peek } from "@virgultum/editor/components/peek";
import type { EmbedSyncedDocModel } from "@virgultum/model";
import type { BlockStdScope } from "@virgultum/std";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CopyLinkButton, DocInfoButton } from "./common";
import { EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT } from "./geometry";

const ToggleButton = ({ model }: { model: EmbedSyncedDocModel }) => {
  const [isFolded, setIsFolded] = useState(model.isFolded);
  const t = useI18n();

  useEffect(
    () => model.props.preFoldHeight$.subscribe((value) => setIsFolded(!!value)),
    [model.props.preFoldHeight$],
  );

  const toggle = useCallback(() => {
    model.store.captureSync();

    batch(() => {
      const { x, y, w, h } = model.elementBound;
      if (model.isFolded) {
        model.props.xywh$.value = `[${x},${y},${w},${model.props.preFoldHeight$.peek() ?? 1}]`;
        model.props.preFoldHeight$.value = 0;
      } else {
        model.props.preFoldHeight$.value = h;
        model.props.xywh$.value = `[${x},${y},${w},${
          EDGELESS_BLOCK_HEADER_COLLAPSED_HEIGHT * (model.props.scale ?? 1)
        }]`;
      }
    });
  }, [model]);

  return (
    <IconButton
      data-testid="edgeless-embed-synced-doc-fold-button"
      data-folded={isFolded}
      onClick={toggle}
      tooltip={
        isFolded
          ? t["com.myoxus.editor.edgeless-embed-synced-doc-header.unfold"]()
          : t["com.myoxus.editor.edgeless-embed-synced-doc-header.fold"]()
      }
      icon={isFolded ? <ToggleRightIcon /> : <ToggleDownIcon />}
    />
  );
};

const Title = ({ model }: { model: EmbedSyncedDocModel }) => {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const title = useLiveData(
    docDisplayMetaService.title$(model.props.pageId, {
      title: model.props.title,
      reference: true,
    }),
  );

  return (
    <CanvasOverlayTitleSlot
      data-collapsed={!!model.props.preFoldHeight}
      data-testid="edgeless-embed-synced-doc-title"
    >
      <CanvasOverlayTitleIcon>
        <LinkedPageIcon />
      </CanvasOverlayTitleIcon>
      <CanvasOverlayTitleText
        emphasis={model.props.preFoldHeight ? "balanced" : "default"}
      >
        {title}
      </CanvasOverlayTitleText>
    </CanvasOverlayTitleSlot>
  );
};

const EmbedSyncedDocInfoButton = ({
  model,
}: {
  model: EmbedSyncedDocModel;
}) => {
  return (
    <DocInfoButton
      docId={model.props.pageId}
      data-testid="edgeless-embed-synced-doc-info-button"
    />
  );
};

const EmbedSyncedDocCopyLinkButton = ({
  model,
}: {
  model: EmbedSyncedDocModel;
}) => {
  return (
    <CopyLinkButton
      pageId={model.props.pageId}
      data-testid="edgeless-embed-synced-doc-copy-link-button"
    />
  );
};

const OpenButton = ({
  std,
  model,
}: {
  std: BlockStdScope;
  model: EmbedSyncedDocModel;
}) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;

  const open = useCallback(() => {
    workbench.openDoc({
      docId: model.props.pageId,
    });
  }, [model.props.pageId, workbench]);

  return (
    <div>
      <Button variant="plain" onClick={open} prefix={<ExpandFullIcon />}>
        {t["com.myoxus.editor.edgeless-embed-synced-doc-header.open"]()}
      </Button>
      <MoreMenu model={model} std={std} />
    </div>
  );
};

const MoreMenu = ({
  model,
  std,
}: {
  model: EmbedSyncedDocModel;
  std: BlockStdScope;
}) => {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;

  const controls = useMemo(() => {
    return [
      {
        type: "open-in-active-view",
        label: t["com.myoxus.peek-view-controls.open-doc"](),
        icon: <ExpandFullIcon />,
        onClick: () => {
          workbench.openDoc(model.props.pageId);
        },
        enabled: true,
      },
      {
        type: "open-in-center-peek",
        label: t["com.myoxus.peek-view-controls.open-doc-in-center-peek"](),
        icon: <CenterPeekIcon />,
        onClick: () => {
          const block = std.view.getBlock(model.id);
          if (!(
            block instanceof EmbedSyncedDocBlockComponent && isPeekable(block)
          ))
            return;
          peek(block);
        },
        enabled: true,
      },
      {
        type: "open-in-split-view",
        label: t["com.myoxus.peek-view-controls.open-doc-in-split-view"](),
        icon: <SplitViewIcon />,
        onClick: () => {
          workbench.openDoc(model.props.pageId, { at: "beside" });
        },
        enabled: BUILD_CONFIG.isElectron,
      },
      {
        type: "open-in-new-tab",
        label: t["com.myoxus.peek-view-controls.open-doc-in-new-tab"](),
        icon: <OpenInNewIcon />,
        onClick: () => {
          workbench.openDoc(model.props.pageId, {
            at: "new-tab",
          });
        },
        enabled: true,
      },
    ].filter(({ enabled }) => enabled);
  }, [model.id, model.props.pageId, std.view, t, workbench]);

  return (
    <Menu
      items={controls.map((option) => (
        <MenuItem
          key={option.type}
          type="default"
          prefixIcon={option.icon}
          onClick={option.onClick}
        >
          {option.label}
        </MenuItem>
      ))}
      contentOptions={{
        align: "center",
      }}
    >
      <IconButton
        icon={<ArrowDownSmallIcon />}
        onDoubleClickCapture={stopPropagation}
      />
    </Menu>
  );
};

export const EdgelessEmbedSyncedDocHeader = ({
  model,
  std,
}: {
  model: EmbedSyncedDocModel;
  std: BlockStdScope;
}) => {
  return (
    <CanvasOverlayToolbar onPointerDown={stopPropagation}>
      <ToggleButton model={model} />
      <Title model={model} />
      <OpenButton std={std} model={model} />
      <EmbedSyncedDocInfoButton model={model} />
      <EmbedSyncedDocCopyLinkButton model={model} />
    </CanvasOverlayToolbar>
  );
};
