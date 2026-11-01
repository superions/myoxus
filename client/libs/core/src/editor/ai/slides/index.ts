import { createTemplateJob } from "@virgultum/editor/gfx/template";
import type { EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { BlockSnapshot } from "@virgultum/editor/store";

import { markdownToSnapshot } from "../../utils";
import { getSurfaceElementFromEditor } from "../utils/selection-utils";
import {
  basicTheme,
  type PPTDoc,
  type PPTSection,
  type TemplateImage,
} from "./template";

export const PPTBuilder = (host: EditorHost, sourceHost: EditorHost = host) => {
  const gfx = host.std.get(GfxControllerIdentifier);
  const docs: PPTDoc[] = [];
  const contents: unknown[] = [];
  const allImages: TemplateImage[][] = [];
  const root = host.store.root;

  const addDoc = async (block: BlockSnapshot, assertCurrent: () => void) => {
    const beforeWrite = () => {
      assertCurrent();
      if (
        !host.isConnected ||
        !sourceHost.isConnected ||
        host.store.readonly ||
        !root ||
        host.store.root !== root
      )
        throw new Error("Markdown slide preview destination unavailable");
    };
    beforeWrite();
    const sections = block.children.map((v) => {
      const title = getText(v);
      const keywords = getText(v.children[0]);
      const content = getText(v.children[1]);
      return {
        title,
        keywords,
        content,
      } satisfies PPTSection;
    });
    const doc: PPTDoc = {
      isCover: docs.length === 0,
      title: getText(block),
      sections,
    };
    const job = createTemplateJob(host.std, "template");
    using transformer = job.job;
    const { images, content } = await basicTheme(doc);
    if (images.length) {
      await Promise.all(
        images.map(({ id, url }) =>
          fetch(url)
            .then((res) => res.blob())
            .then((blob) => transformer.assets.set(id, blob)),
        ),
      );
    }
    await job.insertTemplate(content, beforeWrite);
    docs.push(doc);
    contents.push(content);
    allImages.push(images);
    getSurfaceElementFromEditor(host)?.refresh();
  };

  return {
    process: async (text: string) => {
      try {
        const snapshot = await markdownToSnapshot(text, host.store, sourceHost);
        try {
          const block = snapshot.snapshot?.content[0];
          if (!block) {
            return;
          }
          for (const child of block.children) {
            await addDoc(child, snapshot.assertCurrent);
            gfx.fitToScreen();
          }
        } finally {
          snapshot.transformer[Symbol.dispose]();
        }
      } catch (e) {
        console.error(e);
      }

      return { contents, images: allImages };
    },
    done: async (text: string) => {
      const snapshot = await markdownToSnapshot(text, host.store, sourceHost);
      try {
        const block = snapshot.snapshot?.content[0];
        if (!block) {
          return;
        }
        const last = block.children.at(-1);
        if (last) await addDoc(last, snapshot.assertCurrent);
      } finally {
        snapshot.transformer[Symbol.dispose]();
      }
    },
  };
};

const getText = (block: BlockSnapshot) => {
  // @ts-expect-error allow
  return block.props.text?.delta?.[0]?.insert ?? "";
};
