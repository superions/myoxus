import { getViewManager } from "@myoxus/core/editor/manager/view";
import {
  type EditorSettingSchema,
  EditorSettingService,
} from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework } from "@myoxus/infra";
import { EdgelessCRUDIdentifier } from "@virgultum/editor/blocks/surface";
import { Bound } from "@virgultum/editor/global/gfx";
import { ViewportElementExtension } from "@virgultum/editor/shared/services";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import {
  GfxControllerIdentifier,
  type GfxPrimitiveElementModel,
} from "@virgultum/editor/std/gfx";
import type { Block, Store } from "@virgultum/editor/store";
import { isEqual } from "lodash-es";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { map, pairwise } from "rxjs";

import {
  EditorPreviewFrame,
  type EditorPreviewSize,
  EditorPreviewSkeleton,
  EditorPreviewViewport,
} from "../../../primitives";
import { type DocName, getDocByName } from "./docs";
import { getFrameBlock } from "./utils";

interface Props {
  title: string;
  docName: DocName;
  keyName: keyof EditorSettingSchema;
  previewSize?: EditorPreviewSize;
  getElements: (doc: Store) => Array<Block | GfxPrimitiveElementModel>;
  firstUpdate?: (doc: Store, editorHost: EditorHost) => void;
  applySettings?: (doc: Store, editorHost: EditorHost) => Bound | void;
  children?: React.ReactElement;
}

const boundMap = new Map<DocName, Bound>();

const translate = (
  t: ReturnType<typeof useI18n>,
  key: string,
  fallback: string,
) => {
  const candidate = (
    t as unknown as Record<string, (() => string) | undefined>
  )[key];
  return candidate?.() ?? fallback;
};

const usePreviewTextReplacements = (docName: DocName) => {
  const t = useI18n();
  return useMemo(() => {
    const replacements: Record<string, string> = {
      "Frame 1": translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.common.frame",
        "Frame 1",
      ),
    };

    if (
      docName === "flow" ||
      docName === "mindmap" ||
      docName === "pen" ||
      docName === "shape"
    ) {
      replacements["Virgultum Playground"] = translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.common.playground",
        "Virgultum Playground",
      );
    }

    if (docName === "connector") {
      replacements.label = translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.connector.label",
        "label",
      );
    }
    if (docName === "flow") {
      Object.assign(replacements, {
        Start: translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.flow.start",
          "Start",
        ),
        Action: translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.flow.action",
          "Action",
        ),
        "Yes/No": translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.flow.yes-no",
          "Yes/No",
        ),
        End: translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.flow.end",
          "End",
        ),
        Others: translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.flow.others",
          "Others",
        ),
      });
    }
    if (docName === "frame") {
      replacements.FrameDoc = translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.frame.title",
        "FrameDoc",
      );
    }
    if (docName === "mindmap") {
      replacements["Mind Map"] = translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.mindmap.title",
        "Mind Map",
      );
      replacements.Text = translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.mindmap.text",
        "Text",
      );
    }
    if (docName === "note") {
      Object.assign(replacements, {
        Note: translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.note.title",
          "Note",
        ),
        "Write, draw, plan all at once.": translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.note.headline",
          "Write, draw, plan all at once.",
        ),
        "Myoxus is a workspace with fully merged docs,": translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.note.body1",
          "Myoxus is a workspace with fully merged docs,",
        ),
        "whiteboards and databases.": translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.note.body2",
          "whiteboards and databases.",
        ),
      });
    }
    if (docName === "shape") {
      replacements.Shapes = translate(
        t,
        "com.myoxus.settings.editorSettings.edgeless.preview.shape.title",
        "Shapes",
      );
    }
    if (docName === "text") {
      Object.assign(replacements, {
        TextDoc: translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.text.title",
          "TextDoc",
        ),
        "To Shape,": translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.text.to-shape",
          "To Shape,",
        ),
        "Not to Adopt.": translate(
          t,
          "com.myoxus.settings.editorSettings.edgeless.preview.text.not-to-adopt",
          "Not to Adopt.",
        ),
      });
    }

    return replacements;
  }, [docName, t]);
};

export const EdgelessSnapshot = (props: Props) => {
  const {
    docName,
    keyName,
    previewSize = "default",
    getElements,
    firstUpdate,
    applySettings,
    children,
  } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<Store | null>(null);
  const editorHostRef = useRef<EditorHost | null>(null);
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const textReplacements = usePreviewTextReplacements(docName);

  const extensions = useMemo(() => {
    const manager = getViewManager()
      .config.init()
      .foundation(framework)
      .theme(framework)
      .database(framework)
      .linkedDoc(framework)
      .codeBlockPreview(framework).value;
    return manager
      .get("preview-edgeless")
      .concat([ViewportElementExtension(".setting-editor-snapshot")]);
  }, [framework]);

  const updateElements = useCallback(() => {
    const editorHost = editorHostRef.current;
    const doc = docRef.current;
    if (!editorHost || !doc) return;
    doc.readonly = false;
    try {
      if (applySettings) {
        const bound = applySettings(doc, editorHost);
        if (bound) {
          boundMap.set(docName, bound);
          const frame = getFrameBlock(doc);
          if (frame) doc.updateBlock(frame, { xywh: bound.serialize() });
          const gfx = editorHost.std.get(GfxControllerIdentifier);
          if (gfx.viewport.width && gfx.viewport.height)
            gfx.viewport.setViewportByBound(bound);
        }
      } else {
        const crud = editorHost.std.get(EdgelessCRUDIdentifier);
        const elements = getElements(doc);
        const values = editorSetting.get(keyName) as any;
        elements.forEach((element) => crud.updateElement(element.id, values));
      }
    } finally {
      doc.readonly = true;
    }
  }, [applySettings, docName, editorSetting, getElements, keyName]);

  const renderEditor = useCallback(async () => {
    if (!wrapperRef.current) return;
    const doc = await getDocByName(docName, { textReplacements });
    if (!doc) return;

    const editorHost = new BlockStdScope({
      store: doc,
      extensions,
    }).render();
    docRef.current = doc;
    editorHostRef.current?.remove();
    editorHostRef.current = editorHost;

    if (firstUpdate) {
      firstUpdate(doc, editorHost);
    } else {
      updateElements();
    }

    // refresh viewport
    const gfx = editorHost.std.get(GfxControllerIdentifier);
    const disposable = editorHost.std.view.viewUpdated.subscribe((payload) => {
      if (
        payload.type !== "block" ||
        payload.method !== "add" ||
        payload.view.model.flavour !== "myoxus:page"
      ) {
        return;
      }
      doc.readonly = false;
      const frame = getFrameBlock(doc);
      if (frame && docName !== "frame") {
        // docName with value 'frame' shouldn't be deleted, it is a part of frame settings
        boundMap.set(docName, Bound.deserialize(frame.xywh));
        doc.deleteBlock(frame);
      }
      const bound = boundMap.get(docName);
      bound && gfx.viewport.setViewportByBound(bound);
      doc.readonly = true;
      disposable.unsubscribe();
    });

    // append to dom node
    wrapperRef.current.append(editorHost);
  }, [docName, extensions, firstUpdate, textReplacements, updateElements]);

  useEffect(() => {
    renderEditor();
    return () => editorHostRef.current?.remove();
  }, [renderEditor]);

  // observe editor settings change
  useEffect(() => {
    const sub = editorSetting.provider
      .watchAll()
      .pipe(
        map((settings) => {
          if (typeof settings[keyName] === "string") {
            return JSON.parse(settings[keyName]);
          }
          return keyName;
        }),
        pairwise(),
      )
      .subscribe(([prev, current]) => {
        if (!isEqual(prev, current)) {
          updateElements();
        }
      });
    return () => sub.unsubscribe();
  }, [editorSetting.provider, keyName, updateElements]);

  return (
    <EditorPreviewFrame>
      <EditorPreviewViewport ref={wrapperRef} size={previewSize}>
        <EditorPreviewSkeleton />
      </EditorPreviewViewport>
      {children}
    </EditorPreviewFrame>
  );
};
