import { ObjectPool, Service } from "@myoxus/infra";
import type { Store } from "@virgultum/core/store";

import { DocCommentEntity } from "../entities/doc-comment";

type DocId = string;

export class DocCommentManagerService extends Service {
  private readonly pool = new ObjectPool<DocId, DocCommentEntity>({
    onDelete: (entity) => {
      entity.dispose();
    },
  });

  get(store: Store) {
    const docId = store.id;
    const ref =
      this.pool.get(docId) ??
      this.pool.put(
        docId,
        this.framework.createEntity(DocCommentEntity, { docId }),
      );
    ref.obj.documentStore = store;
    return ref;
  }
}
