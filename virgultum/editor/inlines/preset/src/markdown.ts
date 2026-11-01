import { LatexExtension } from "@virgultum/inline-latex";
import { ParagraphBlockModel } from "@virgultum/model";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { InlineMarkdownExtension } from "@virgultum/std/inline";
import type { ExtensionType } from "@virgultum/store";
import { nanoid, Text } from "@virgultum/store";
import type { BlockComponent } from "@virgultum/std";
import { findAnnotationSyntaxSpans } from "@virgultum/shared/adapters";

export const AnnotationMarkdown = InlineMarkdownExtension<MyoxusTextAttributes>(
  {
    name: "annotation",
    pattern: /%%$/,
    trigger: "%",
    fullPrefix: true,
    action: ({ inlineEditor, prefixText, inlineRange, undoManager }) => {
      const owner =
        inlineEditor.rootElement?.closest<BlockComponent>("[data-block-id]");
      const model = owner?.model;
      if (
        !model ||
        model.store.readonly ||
        model.flavour === "myoxus:code" ||
        model.flavour === "myoxus:annotation"
      )
        return false;
      // Previously rendered code/annotation bodies must not poison Markdown
      // recognition in the ordinary text after them.
      let eligibleStart = 0;
      let offset = 0;
      for (const delta of model.text?.sliceToDelta(0, inlineRange.index) ??
        []) {
        offset += delta.insert?.length ?? 0;
        if (
          delta.attributes?.code ||
          delta.attributes?.annotation ||
          delta.attributes?.reference ||
          delta.attributes?.latex
        )
          eligibleStart = offset;
      }
      const relative = findAnnotationSyntaxSpans(
        prefixText.slice(eligibleStart),
      ).findLast(
        (span) =>
          span.index + span.length === inlineRange.index - eligibleStart,
      );
      if (!relative) return false;
      const span = { ...relative, index: relative.index + eligibleStart };
      const deltas = model.text?.sliceToDelta(
        span.index,
        span.index + span.length,
      );
      if (
        !deltas ||
        deltas.some(
          (delta) => delta.attributes?.code || delta.attributes?.annotation,
        )
      )
        return false;
      const store = model.store;
      const parent = store.getParent(model);
      const standalone =
        span.standalone &&
        !prefixText.slice(0, span.index).trim() &&
        span.index + span.length === inlineEditor.yText.length &&
        model instanceof ParagraphBlockModel &&
        model.props.type === "text" &&
        parent;
      if (!standalone && !span.body) return false;
      undoManager.stopCapturing();
      store.transact(() => {
        if (standalone) {
          const id = store.addBlock(
            "myoxus:annotation",
            { text: new Text(span.body) },
            parent,
            parent.children.indexOf(model),
          );
          if (model.children.length)
            store.moveBlocks(
              [...model.children],
              parent,
              store.getModelById(id),
              false,
            );
          store.deleteBlock(model);
          void owner.std.host.updateComplete.then(() => {
            const block = owner.std.view.getBlock(id);
            if (block?.flavour === "myoxus:annotation")
              (
                block as HTMLElementTagNameMap["myoxus-annotation"]
              ).startEditing();
          });
        } else {
          inlineEditor.yText.delete(span.index, span.length);
          inlineEditor.yText.insert(span.index, span.body, {
            annotation: { id: nanoid() },
          });
        }
      });
      undoManager.stopCapturing();
      if (!standalone)
        inlineEditor.setInlineRange({
          index: span.index + span.body.length,
          length: 0,
        });
      return true;
    },
  },
);

// inline markdown match rules:
// covert: ***test*** + space
// covert: ***t est*** + space
// not convert: *** test*** + space
// not convert: ***test *** + space
// not convert: *** test *** + space

export const BoldItalicMarkdown = InlineMarkdownExtension<MyoxusTextAttributes>(
  {
    name: "bolditalic",
    pattern: /.*\*{3}([^\s*][^*]*[^\s*])\*{3}\s$|.*\*{3}([^\s*])\*{3}\s$/,
    action: ({
      inlineEditor,
      prefixText,
      inlineRange,
      pattern,
      undoManager,
    }) => {
      const match = prefixText.match(pattern);
      if (!match) return;

      const targetText = match[1] ?? match[2];
      const annotatedText = match[0].slice(
        -(targetText.length + 3 * 2 + 1),
        -1,
      );
      const startIndex = inlineRange.index - annotatedText.length - 1;

      undoManager.stopCapturing();

      inlineEditor.formatText(
        {
          index: startIndex,
          length: annotatedText.length,
        },
        {
          bold: true,
          italic: true,
        },
      );

      inlineEditor.deleteText({
        index: inlineRange.index - 4,
        length: 4,
      });
      inlineEditor.deleteText({
        index: startIndex,
        length: 3,
      });
      inlineEditor.setInlineRange({
        index: startIndex + annotatedText.length - 6,
        length: 0,
      });
    },
  },
);

export const BoldMarkdown = InlineMarkdownExtension<MyoxusTextAttributes>({
  name: "bold",
  pattern: /.*\*{2}([^\s][^*]*[^\s*])\*{2}\s$|.*\*{2}([^\s*])\*{2}\s$/,
  action: ({ inlineEditor, prefixText, inlineRange, pattern, undoManager }) => {
    const match = prefixText.match(pattern);
    if (!match) return;

    const targetText = match[1] ?? match[2];
    const annotatedText = match[0].slice(-(targetText.length + 2 * 2 + 1), -1);
    const startIndex = inlineRange.index - annotatedText.length - 1;

    undoManager.stopCapturing();

    inlineEditor.formatText(
      {
        index: startIndex,
        length: annotatedText.length,
      },
      {
        bold: true,
      },
    );

    inlineEditor.deleteText({
      index: inlineRange.index - 3,
      length: 3,
    });
    inlineEditor.deleteText({
      index: startIndex,
      length: 2,
    });
    inlineEditor.setInlineRange({
      index: startIndex + annotatedText.length - 4,
      length: 0,
    });
  },
});

export const ItalicExtension = InlineMarkdownExtension<MyoxusTextAttributes>({
  name: "italic",
  pattern: /.*\*{1}([^\s][^*]*[^\s*])\*{1}\s$|.*\*{1}([^\s*])\*{1}\s$/,
  action: ({ inlineEditor, prefixText, inlineRange, pattern, undoManager }) => {
    const match = prefixText.match(pattern);
    if (!match) return;

    const targetText = match[1] ?? match[2];
    const annotatedText = match[0].slice(-(targetText.length + 1 * 2 + 1), -1);
    const startIndex = inlineRange.index - annotatedText.length - 1;

    undoManager.stopCapturing();

    inlineEditor.formatText(
      {
        index: startIndex,
        length: annotatedText.length,
      },
      {
        italic: true,
      },
    );

    inlineEditor.deleteText({
      index: inlineRange.index - 2,
      length: 2,
    });
    inlineEditor.deleteText({
      index: startIndex,
      length: 1,
    });
    inlineEditor.setInlineRange({
      index: startIndex + annotatedText.length - 2,
      length: 0,
    });
  },
});

export const StrikethroughExtension =
  InlineMarkdownExtension<MyoxusTextAttributes>({
    name: "strikethrough",
    pattern: /.*~{2}([^\s][^~]*[^\s])~{2}\s$|.*~{2}([^\s~])~{2}\s$/,
    action: ({
      inlineEditor,
      prefixText,
      inlineRange,
      pattern,
      undoManager,
    }) => {
      const match = prefixText.match(pattern);
      if (!match) return;

      const targetText = match[1] ?? match[2];
      const annotatedText = match[0].slice(
        -targetText.length - (2 * 2 + 1),
        -1,
      );
      const startIndex = inlineRange.index - annotatedText.length - 1;

      undoManager.stopCapturing();

      inlineEditor.formatText(
        {
          index: startIndex,
          length: annotatedText.length,
        },
        {
          strike: true,
        },
      );

      inlineEditor.deleteText({
        index: inlineRange.index - 3,
        length: 3,
      });
      inlineEditor.deleteText({
        index: startIndex,
        length: 2,
      });

      inlineEditor.setInlineRange({
        index: startIndex + annotatedText.length - 4,
        length: 0,
      });
    },
  });

export const UnderthroughExtension =
  InlineMarkdownExtension<MyoxusTextAttributes>({
    name: "underthrough",
    pattern: /.*~{1}([^\s][^~]*[^\s~])~{1}\s$|.*~{1}([^\s~])~{1}\s$/,
    action: ({
      inlineEditor,
      prefixText,
      inlineRange,
      pattern,
      undoManager,
    }) => {
      const match = prefixText.match(pattern);
      if (!match) return;

      const targetText = match[1] ?? match[2];
      const annotatedText = match[0].slice(
        -(targetText.length + 1 * 2 + 1),
        -1,
      );
      const startIndex = inlineRange.index - annotatedText.length - 1;

      undoManager.stopCapturing();

      inlineEditor.formatText(
        {
          index: startIndex,
          length: annotatedText.length,
        },
        {
          underline: true,
        },
      );

      inlineEditor.deleteText({
        index: inlineRange.index - 2,
        length: 2,
      });
      inlineEditor.deleteText({
        index: startIndex,
        length: 1,
      });

      inlineEditor.setInlineRange({
        index: startIndex + annotatedText.length - 2,
        length: 0,
      });
    },
  });

export const CodeExtension = InlineMarkdownExtension<MyoxusTextAttributes>({
  name: "code",
  pattern: /.*`([^\s][^`]*[^\s])`\s$|.*`([^\s`])`\s$/,
  action: ({ inlineEditor, prefixText, inlineRange, pattern, undoManager }) => {
    const match = prefixText.match(pattern);
    if (!match) return;

    const targetText = match[1] ?? match[2];
    const annotatedText = match[0].slice(-(targetText.length + 1 * 2 + 1), -1);
    const startIndex = inlineRange.index - annotatedText.length - 1;

    undoManager.stopCapturing();

    inlineEditor.formatText(
      {
        index: startIndex,
        length: annotatedText.length,
      },
      {
        code: true,
      },
    );

    inlineEditor.deleteText({
      index: inlineRange.index - 2,
      length: 2,
    });
    inlineEditor.deleteText({
      index: startIndex,
      length: 1,
    });

    inlineEditor.setInlineRange({
      index: startIndex + annotatedText.length - 2,
      length: 0,
    });
  },
});

export const MarkdownExtensions: ExtensionType[] = [
  AnnotationMarkdown,
  BoldItalicMarkdown,
  BoldMarkdown,
  ItalicExtension,
  StrikethroughExtension,
  UnderthroughExtension,
  CodeExtension,
  LatexExtension,
];
