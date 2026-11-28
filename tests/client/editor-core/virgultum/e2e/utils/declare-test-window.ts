import type * as NoteBlocks from "@virgultum/editor/blocks/note";
import type * as Effect from "@virgultum/editor/effects";
import type * as GlobalUtils from "@virgultum/editor/global/utils";
import type * as SharedServices from "@virgultum/editor/shared/services";
import type * as BlockStd from "@virgultum/editor/std";
import type { EditorHost } from "@virgultum/editor/std";
import type * as StoreModule from "@virgultum/editor/store";
import type { Store, Transformer, Workspace } from "@virgultum/editor/store";
import type * as IntegrationTest from "@virgultum/integration-test";
import type { TestMyoxusEditorContainer } from "@virgultum/integration-test";
import type * as EditorModel from "@virgultum/core/models";

declare type _GLOBAL_ = typeof Effect;

declare global {
  interface Window {
    applyNativeUpdate: (update: number[]) => Promise<void>;
    mountFrameNavigatorFixture: (host: EditorHost) => {
      setHost(host: EditorHost): void;
      unmount(): void;
    };
    __frameNavigatorFixture?: {
      setHost(host: EditorHost): void;
      unmount(): void;
    };
    /** Available on the Virgultum integration-test window.
     * The following instances are initialized by `@virgultum/integration-test`.
     */
    $virgultum: {
      store: typeof StoreModule;
      blocks: {
        note: typeof NoteBlocks;
      };
      global: {
        utils: typeof GlobalUtils;
      };
      services: typeof SharedServices;
      editor: typeof IntegrationTest;
      blockStd: typeof BlockStd;
      editorModel: typeof EditorModel;
    };
    collection: Workspace;
    doc: Store;
    editor: TestMyoxusEditorContainer;
    host: EditorHost;
    job: Transformer;
  }
}
