import {
  createYProxy,
  type DocMeta,
  type DocsPropertiesMeta,
  type WorkspaceMeta,
} from "@virgultum/editor/store";
import { LiveData, yjsObserveDeep } from "@myoxus/infra";
import { map, Subject, switchMap } from "rxjs";
import {
  Array as YArray,
  Map as YMap,
  type Doc as YDoc,
  type YEvent,
  type Text as YText,
} from "yjs";

type MetaState = {
  pages?: unknown[];
  properties?: DocsPropertiesMeta;
  name?: string;
  avatar?: string;
};

export class WorkspaceMetaImpl implements WorkspaceMeta {
  commonFieldsUpdated = new Subject<void>();
  docMetaAdded = new Subject<string>();
  docMetaRemoved = new Subject<string>();
  docMetaUpdated = new Subject<void>();

  private readonly _handleDocCollectionMetaEvents = (
    events: YEvent<YArray<unknown> | YText | YMap<unknown>>[],
  ) => {
    let docMetaChanged = false;
    let membershipChanged = false;
    let commonFieldsChanged = false;
    const pages = this.yDocs;
    for (const e of events) {
      const hasKey = (k: string) =>
        e.target === this._yMap && e.changes.keys.has(k);

      if (hasKey("pages") || e.target === pages) {
        membershipChanged = true;
        docMetaChanged = true;
      } else if (e.target.parent === pages) {
        docMetaChanged = true;
        if (e.changes.keys.has("id")) membershipChanged = true;
      }

      if (hasKey("name") || hasKey("avatar")) {
        commonFieldsChanged = true;
      }
    }
    if (membershipChanged) this._rebuildDocIndex(true);
    if (docMetaChanged) this.docMetaUpdated.next();
    if (commonFieldsChanged) this._handleCommonFieldsEvent();
  };

  private readonly _id: string = "meta";
  private readonly _doc: YDoc;
  private readonly _proxy: MetaState;
  private readonly _yMap: YMap<MetaState[keyof MetaState]>;
  // This read index mirrors one accepted `pages` array snapshot. Separate
  // streams let document observers rebind when a Y.Map is replaced in place.
  private _docMetaById = new Map<string, YMap<unknown>>();
  private readonly _docMetaMapStreams = new Map<
    string,
    LiveData<YMap<unknown> | undefined>
  >();
  private _prevDocs = new Set<string>();

  get avatar() {
    return this._proxy.avatar;
  }

  setAvatar(avatar: string) {
    this._doc.transact(() => {
      this._proxy.avatar = avatar;
    }, this._doc.clientID);
  }

  get name() {
    return this._proxy.name;
  }

  setName(name: string) {
    this._doc.transact(() => {
      this._proxy.name = name;
    }, this._doc.clientID);
  }

  get properties(): DocsPropertiesMeta {
    const meta = this._proxy.properties;
    if (!meta) {
      return {
        tags: {
          options: [],
        },
      };
    }
    return meta;
  }

  setProperties(meta: DocsPropertiesMeta) {
    this._proxy.properties = meta;
    this.docMetaUpdated.next();
  }

  get docMetas() {
    if (!this._proxy.pages) {
      return [] as DocMeta[];
    }
    return this._proxy.pages as DocMeta[];
  }

  get docs() {
    return this._proxy.pages;
  }

  get yDocs() {
    return this._yMap.get("pages") as unknown as YArray<unknown>;
  }

  constructor(doc: YDoc) {
    this._doc = doc;
    const map = doc.getMap(this._id) as YMap<MetaState[keyof MetaState]>;
    this._yMap = map;
    this._proxy = createYProxy(map);
    this._rebuildDocIndex(false);
    this._yMap.observeDeep(this._handleDocCollectionMetaEvents);
  }

  private _handleCommonFieldsEvent() {
    this.commonFieldsUpdated.next();
  }

  private _rebuildDocIndex(notifyMembership: boolean) {
    const next = new Map<string, YMap<unknown>>();
    const pages = this.yDocs;
    if (pages instanceof YArray) {
      for (const value of pages) {
        if (!(value instanceof YMap)) continue;
        const id = value.get("id");
        if (typeof id === "string" && !next.has(id)) next.set(id, value);
      }
    }

    this._docMetaById = next;
    const nextIds = new Set(next.keys());
    for (const [id, stream] of this._docMetaMapStreams) {
      const value = next.get(id);
      if (stream.value !== value) stream.next(value);
    }
    if (notifyMembership) {
      for (const id of nextIds) {
        if (!this._prevDocs.has(id)) this.docMetaAdded.next(id);
      }
      for (const id of this._prevDocs) {
        if (!nextIds.has(id)) this.docMetaRemoved.next(id);
      }
    }
    this._prevDocs = nextIds;
  }

  addDocMeta(doc: DocMeta, index?: number) {
    this._doc.transact(() => {
      if (!this.docs) {
        return;
      }
      const docs = this.docs as unknown[];
      if (index === undefined) {
        docs.push(doc);
      } else {
        docs.splice(index, 0, doc);
      }
    }, this._doc.clientID);
  }

  getDocMeta(id: string) {
    const meta = this._docMetaById.get(id);
    return meta ? (createYProxy(meta) as DocMeta) : undefined;
  }

  getDocMetaSnapshot(id: string): Partial<DocMeta> {
    return (this._docMetaById.get(id)?.toJSON() as Partial<DocMeta>) ?? {};
  }

  watchDocMeta(id: string) {
    let stream = this._docMetaMapStreams.get(id);
    if (!stream) {
      stream = new LiveData(this._docMetaById.get(id));
      this._docMetaMapStreams.set(id, stream);
    }
    return stream.pipe(
      switchMap(yjsObserveDeep),
      map((meta) =>
        meta instanceof YMap ? (meta.toJSON() as Partial<DocMeta>) : {},
      ),
    );
  }

  initialize() {
    if (!this._proxy.pages) {
      this._proxy.pages = [];
    }
  }

  removeDocMeta(id: string) {
    // you cannot delete a doc if there's no doc
    if (!this.docs) {
      return;
    }

    const docMeta = this.docMetas;
    const index = docMeta.findIndex((doc: DocMeta) => id === doc.id);
    if (index === -1) {
      return;
    }
    this._doc.transact(() => {
      if (!this.docs) {
        return;
      }
      this.docs.splice(index, 1);
    }, this._doc.clientID);
  }

  setDocMeta(id: string, props: Partial<DocMeta>) {
    const docs = (this.docs as DocMeta[]) ?? [];
    const index = docs.findIndex((doc: DocMeta) => id === doc.id);

    this._doc.transact(() => {
      if (!this.docs) {
        return;
      }
      if (index === -1) return;

      const doc = this.docs[index] as Record<string, unknown>;
      Object.entries(props).forEach(([key, value]) => {
        doc[key] = value;
      });
    }, this._doc.clientID);
  }
}
