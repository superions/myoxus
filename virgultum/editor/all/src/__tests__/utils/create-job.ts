import { defaultImageProxyMiddleware } from "@virgultum/shared/adapters";
import {
  Schema,
  Transformer,
  type TransformerMiddleware,
} from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";

import { MyoxusSchemas } from "../../schemas.js";
import { testStoreExtensions } from "./store.js";

declare global {
  interface Window {
    happyDOM: {
      settings: {
        fetch: {
          disableSameOriginPolicy: boolean;
        };
      };
    };
  }
}

export function createJob(middlewares?: TransformerMiddleware[]) {
  window.happyDOM.settings.fetch.disableSameOriginPolicy = true;
  const testMiddlewares = middlewares ?? [];
  testMiddlewares.push(defaultImageProxyMiddleware);
  const schema = new Schema().register(MyoxusSchemas);
  const docCollection = new TestWorkspace();
  docCollection.storeExtensions = testStoreExtensions;
  docCollection.meta.initialize();
  return new Transformer({
    schema,
    blobCRUD: docCollection.blobSync,
    middlewares: testMiddlewares,
    docCRUD: {
      create: (id: string) => docCollection.createDoc(id).getStore({ id }),
      get: (id: string) => docCollection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => docCollection.removeDoc(id),
    },
  });
}
