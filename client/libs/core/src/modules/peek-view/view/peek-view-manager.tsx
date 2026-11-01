import { useLiveData, useService } from "@myoxus/infra";
import { toReactNode } from "@myoxus/lit-react";
import { BlockComponent } from "@virgultum/editor/std";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ActivePeekView } from "../entities/peek-view";
import { PeekViewService } from "../services/peek-view";
import { AIChatBlockPeekView } from "./ai-chat-block-peek-view";
import { AttachmentPreviewPeekView } from "./attachment-preview";
import { DocPeekPreview } from "./doc-preview";
import {
  GenericImagePreviewModalWithClose,
  ImagePreviewPeekView,
} from "./image-preview";
import {
  PeekViewModalContainer,
  type PeekViewModalContainerProps,
} from "./modal-container";
import {
  AttachmentPeekViewControls,
  DefaultPeekViewControls,
  DocPeekViewControls,
} from "./peek-view-controls";

function renderPeekView({ info }: ActivePeekView, animating?: boolean) {
  if (info.type === "template") {
    return toReactNode(info.template);
  }
  if (info.type === "doc") {
    return (
      <DocPeekPreview
        docRef={info.docRef}
        animating={animating}
        reading={info.purpose === "reading"}
        attempt={info.attempt}
      />
    );
  }

  if (info.type === "attachment" && info.docRef.blockIds?.[0]) {
    return (
      <AttachmentPreviewPeekView
        docId={info.docRef.docId}
        blockId={info.docRef.blockIds?.[0]}
      />
    );
  }

  if (info.type === "image" && info.docRef.blockIds?.[0]) {
    return (
      <ImagePreviewPeekView
        docId={info.docRef.docId}
        blockId={info.docRef.blockIds?.[0]}
      />
    );
  }

  if (info.type === "image-list") {
    return <GenericImagePreviewModalWithClose {...info.data} />;
  }

  if (info.type === "ai-chat-block") {
    return <AIChatBlockPeekView model={info.model} host={info.host} />;
  }

  return null; // unreachable
}

const renderControls = ({ info }: ActivePeekView) => {
  if (info.type === "doc") {
    return (
      <DocPeekViewControls
        docRef={info.docRef}
        reading={info.purpose === "reading"}
      />
    );
  }

  if (info.type === "attachment") {
    return <AttachmentPeekViewControls docRef={info.docRef} />;
  }

  if (info.type === "image" || info.type === "image-list") {
    return null; // image controls are rendered in the image preview
  }

  return <DefaultPeekViewControls />;
};

const getMode = (info: ActivePeekView["info"]) => {
  if (info.type === "image" || info.type === "image-list") {
    return "full";
  }
  return "fit";
};

const getRendererProps = (
  activePeekView?: ActivePeekView,
  animating?: boolean,
): Partial<PeekViewModalContainerProps> | undefined => {
  if (!activePeekView) {
    return;
  }

  const preview = renderPeekView(activePeekView, animating);
  const controls = renderControls(activePeekView);
  return {
    children: preview,
    controls,
    target:
      activePeekView?.target.element instanceof HTMLElement
        ? activePeekView.target.element
        : undefined,
    mode: getMode(activePeekView.info),
    animation: "fadeBottom",
    dialogFrame: !["image", "image-list"].includes(activePeekView.info.type),
  };
};

export const PeekViewManagerModal = () => {
  const peekViewEntity = useService(PeekViewService).peekView;
  const activePeekView = useLiveData(peekViewEntity.active$);
  const show = useLiveData(peekViewEntity.show$);

  const [animating, setAnimating] = useState(false);
  const returnFocus = useRef<
    { element: HTMLElement; itemKey?: string } | undefined
  >(undefined);
  useEffect(() => {
    if (
      show?.value &&
      activePeekView?.info.type === "doc" &&
      activePeekView.info.purpose === "reading"
    ) {
      const element = activePeekView.target.element;
      if (element instanceof HTMLElement) {
        returnFocus.current = {
          element,
          itemKey:
            element.closest<HTMLElement>("[data-item-key]")?.dataset.itemKey,
        };
      }
    } else if (show?.value) {
      // A different Peek replacing the reader owns its own close behavior.
      returnFocus.current = undefined;
    } else if (!show?.value && returnFocus.current) {
      const { element, itemKey } = returnFocus.current;
      returnFocus.current = undefined;
      if (!window.location.pathname.endsWith("/all")) return;
      // Virtualization may replace the action. Match the typed inventory key,
      // never a raw document ID that could also denote a Database item.
      const replacement = itemKey
        ? [...document.querySelectorAll<HTMLElement>("[data-item-key]")].find(
            (node) => node.dataset.itemKey === itemKey,
          )
        : undefined;
      const target =
        element.isConnected &&
        (!itemKey ||
          element.closest<HTMLElement>("[data-item-key]")?.dataset.itemKey ===
            itemKey)
          ? element
          : (replacement ??
            document.querySelector<HTMLElement>(
              '[data-myoxus-ui-role="all-documents-chip"] button',
            ));
      target?.focus({ preventScroll: true });
    }
  }, [activePeekView, show?.value]);
  useEffect(() => {
    if (
      !show?.value ||
      activePeekView?.info.type !== "doc" ||
      activePeekView.info.purpose !== "reading"
    )
      return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-myoxus-ui-role="peek-view-modal-controls"] [data-action-name="close"]',
        )
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activePeekView, show?.value]);

  const onAnimationStart = useCallback(() => {
    setAnimating(true);
  }, []);

  const onAnimationEnd = useCallback(() => {
    setAnimating(false);
  }, []);

  const renderProps = useMemo(() => {
    if (!activePeekView) {
      return;
    }
    return getRendererProps(activePeekView, animating);
  }, [activePeekView, animating]);

  useEffect(() => {
    const subscription = peekViewEntity.show$.subscribe(() => {
      if (activePeekView?.target.element instanceof BlockComponent) {
        activePeekView.target.element.requestUpdate();
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [activePeekView, peekViewEntity]);

  return (
    <PeekViewModalContainer
      {...renderProps}
      animation={show?.animation ? renderProps?.animation : "none"}
      open={!!show?.value && !!renderProps}
      onOpenChange={(open) => {
        if (!open) {
          peekViewEntity.close();
        }
      }}
      onAnimationStart={onAnimationStart}
      onAnimationEnd={onAnimationEnd}
    >
      {activePeekView?.info.type === "doc" &&
      activePeekView.info.purpose === "reading" &&
      !show?.value
        ? null
        : renderProps?.children}
    </PeekViewModalContainer>
  );
};
