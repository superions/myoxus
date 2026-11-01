import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceService, WorkspacesService } from "../../workspace";
import { GuardService } from "../../permissions";
import { useLiveData } from "@myoxus/infra";
import { useState } from "react";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  ExpandFullIcon,
  InformationIcon,
  LinkIcon,
  OpenInNewIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { IconButton, notify, PeekViewControls } from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import {
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactElement,
  type SVGAttributes,
  useCallback,
  useEffect,
  useMemo,
} from "react";

import { WorkspaceDialogService } from "../../dialogs";
import { DocsService } from "../../doc/services/docs";
import { toDocSearchParams } from "../../navigation";
import { ServerService } from "../../server";
import { WorkbenchService } from "../../workbench/services/workbench";
import type {
  AttachmentPeekViewInfo,
  DocReferenceInfo,
} from "../entities/peek-view";
import { PeekViewService } from "../services/peek-view";

type ControlButtonProps = {
  nameKey: string;
  icon: ReactElement<SVGAttributes<SVGElement>>;
  name: string;
  onClick: () => void;
  enabled: boolean;
};

const filterByEnabled = (props: ControlButtonProps) => props.enabled;

export const ControlButton = ({
  icon,
  nameKey,
  name,
  onClick,
}: ControlButtonProps) => {
  const handleClick: MouseEventHandler = useCallback(
    (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick();
    },
    [onClick],
  );

  return (
    <IconButton
      variant="default"
      tooltip={name}
      data-testid="peek-view-control"
      data-action-name={nameKey}
      onClick={handleClick}
      icon={icon}
      data-myoxus-ui-role="peek-view-control-button"
    />
  );
};

type DocPeekViewControlsProps = HTMLAttributes<HTMLDivElement> & {
  mode?: DocMode;
  docRef: DocReferenceInfo;
  reading?: boolean;
};

export const DefaultPeekViewControls = ({
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) => {
  const peekView = useService(PeekViewService).peekView;
  const t = useI18n();
  const controls = useMemo(() => {
    return [
      {
        nameKey: "close",
        name: t["com.myoxus.peek-view-controls.close"](),
        icon: <CloseIcon />,
        onClick: () => peekView.close(),
        enabled: true,
      },
    ].filter(filterByEnabled);
  }, [peekView, t]);
  return (
    <PeekViewControls {...rest} className={className}>
      {controls.map((option) => (
        <ControlButton key={option.nameKey} {...option} />
      ))}
    </PeekViewControls>
  );
};

export const DocPeekViewControls = ({
  docRef,
  reading,
  className,
  ...rest
}: DocPeekViewControlsProps) => {
  const peekView = useService(PeekViewService).peekView;
  const workbench = useService(WorkbenchService).workbench;
  const t = useI18n();
  const serverService = useService(ServerService);
  const docsService = useService(DocsService);
  const sourceWorkspace = useService(WorkspaceService).workspace;
  const workspaces = useService(WorkspacesService);
  const sourceGuard = useService(GuardService);
  const { jumpToPageBlock } = useNavigateHelper();
  const targetId = docRef.workspaceId;
  const foreign = targetId !== undefined && targetId !== sourceWorkspace.id;
  const [opened, setOpened] =
    useState<ReturnType<WorkspacesService["openByWorkspaceId"]>>();
  useEffect(() => {
    if (!foreign) {
      setOpened(undefined);
      return;
    }
    const target = workspaces.openByWorkspaceId(targetId);
    setOpened(target);
    return () => target?.dispose();
  }, [foreign, targetId, workspaces]);
  const actualTarget = foreign
    ? opened?.workspace.id === targetId
      ? opened.workspace
      : undefined
    : sourceWorkspace;
  const guard =
    actualTarget?.scope.get(GuardService) ??
    (foreign ? undefined : sourceGuard);
  const canRead = useLiveData(guard?.can$("Doc_Read", docRef.docId));
  useEffect(() => {
    void guard?.can("Doc_Read", docRef.docId).catch(console.error);
  }, [guard, docRef.docId]);
  const scopedDocs =
    actualTarget?.scope.get(DocsService) ?? (foreign ? undefined : docsService);
  const documentUrl = useCallback(() => {
    const mode = docRef.mode ?? scopedDocs?.list.getPrimaryMode(docRef.docId);
    const search = toDocSearchParams({ ...docRef, mode });
    const url = new URL(
      `/workspace/${actualTarget?.id}/${encodeURIComponent(docRef.docId)}`,
      serverService.server.baseUrl,
    );
    if (search?.size) url.search = search.toString();
    return url.toString();
  }, [actualTarget?.id, docRef, scopedDocs, serverService.server.baseUrl]);
  const openDocument = useCallback(
    (at?: "new-tab" | "beside") => {
      if (canRead !== true || !actualTarget) return;
      if (!foreign) workbench.openDoc(docRef, at ? { at } : undefined);
      else if (at === "new-tab")
        window.open(documentUrl(), "_blank", "noopener,noreferrer");
      else
        jumpToPageBlock(
          actualTarget.id,
          docRef.docId,
          docRef.mode,
          docRef.blockIds,
          docRef.elementIds,
        );
      peekView.close(false);
    },
    [
      canRead,
      actualTarget,
      foreign,
      workbench,
      docRef,
      documentUrl,
      jumpToPageBlock,
      peekView,
    ],
  );
  const controls = useMemo(() => {
    return [
      {
        nameKey: "close",
        name: t["com.myoxus.peek-view-controls.close"](),
        icon: <CloseIcon />,
        onClick: () => peekView.close(),
        enabled: true,
      },
      {
        nameKey: "open",
        name: t["com.myoxus.peek-view-controls.open-doc"](),
        icon: <ExpandFullIcon />,
        onClick: () => {
          openDocument();
        },
        enabled: true,
      },
      {
        nameKey: "new-tab",
        name: t["com.myoxus.peek-view-controls.open-doc-in-new-tab"](),
        icon: <OpenInNewIcon />,
        onClick: () => {
          openDocument("new-tab");
        },
        enabled: !reading,
      },
      {
        nameKey: "split-view",
        name: t["com.myoxus.peek-view-controls.open-doc-in-split-view"](),
        icon: <SplitViewIcon />,
        onClick: () => {
          openDocument("beside");
        },
        enabled: !reading && BUILD_CONFIG.isElectron,
      },
      {
        nameKey: "copy-link",
        name: t["com.myoxus.peek-view-controls.copy-link"](),
        icon: <LinkIcon />,
        onClick: async () => {
          if (canRead !== true || !actualTarget) return;
          const url = documentUrl();
          await copyTextToClipboard(url);
          notify.success({ title: t["Copied link to clipboard"]() });
        },
        enabled: !reading,
      },
      {
        nameKey: "info",
        name: t["com.myoxus.peek-view-controls.open-info"](),
        icon: <InformationIcon />,
        onClick: () => {
          if (canRead === true)
            actualTarget?.scope
              .get(WorkspaceDialogService)
              .open("doc-info", { docId: docRef.docId });
        },
        enabled: !reading,
      },
    ].filter(filterByEnabled);
  }, [
    t,
    peekView,
    docRef,
    openDocument,
    documentUrl,
    canRead,
    actualTarget,
    reading,
  ]);
  return (
    <PeekViewControls {...rest} className={className}>
      {controls.map((option) => (
        <ControlButton key={option.nameKey} {...option} />
      ))}
    </PeekViewControls>
  );
};

type AttachmentPeekViewControls = HTMLAttributes<HTMLDivElement> & {
  mode?: DocMode;
  docRef: AttachmentPeekViewInfo["docRef"];
};

export const AttachmentPeekViewControls = ({
  docRef,
  className,
  ...rest
}: AttachmentPeekViewControls) => {
  const { docId, blockIds: [blockId] = [], filetype: type } = docRef;
  const peekView = useService(PeekViewService).peekView;
  const workbench = useService(WorkbenchService).workbench;
  const t = useI18n();

  const controls = useMemo(() => {
    const controls = [
      {
        nameKey: "close",
        name: t["com.myoxus.peek-view-controls.close"](),
        icon: <CloseIcon />,
        onClick: () => peekView.close(),
        enabled: true,
      },
    ];
    if (!type) return controls;

    return [
      ...controls,
      // TODO(@fundon): needs to be implemented on mobile
      {
        nameKey: "open",
        name: t["com.myoxus.peek-view-controls.open-attachment"](),
        icon: <ExpandFullIcon />,
        onClick: () => {
          workbench.openAttachment(docId, blockId);
          peekView.close(false);

          track.$.attachment.$.openAttachmentInFullscreen({ type });
        },
        enabled: BUILD_CONFIG.isDesktopEdition,
      },
      {
        nameKey: "new-tab",
        name: t["com.myoxus.peek-view-controls.open-attachment-in-new-tab"](),
        icon: <OpenInNewIcon />,
        onClick: () => {
          workbench.openAttachment(docId, blockId, { at: "new-tab" });
          peekView.close(false);

          track.$.attachment.$.openAttachmentInNewTab({ type });
        },
        enabled: true,
      },
      {
        nameKey: "split-view",
        name: t[
          "com.myoxus.peek-view-controls.open-attachment-in-split-view"
        ](),
        icon: <SplitViewIcon />,
        onClick: () => {
          workbench.openAttachment(docId, blockId, { at: "beside" });
          peekView.close(false);

          track.$.attachment.$.openAttachmentInSplitView({ type });
        },
        enabled: BUILD_CONFIG.isElectron,
      },
    ].filter(filterByEnabled);
  }, [t, peekView, workbench, docId, blockId, type]);

  useEffect(() => {
    if (type === undefined) return;

    track.$.attachment.$.openAttachmentInPeekView({ type });
  }, [type]);

  return (
    <PeekViewControls {...rest} className={className}>
      {controls.map((option) => (
        <ControlButton key={option.nameKey} {...option} />
      ))}
    </PeekViewControls>
  );
};
