import { VirgultumError } from "@virgultum/global/exceptions";
import {
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
  ListBlockModel,
  ParagraphBlockModel,
  CalloutBlockModel,
  TableBlockModel,
  SurfaceRefBlockModel,
} from "@virgultum/model";
import type {
  AfterImportBlockPayload,
  BeforeImportBlockPayload,
  DeltaOperation,
  TransformerMiddleware,
  Text,
  BlockSnapshot,
} from "@virgultum/store";
import { filter, map } from "rxjs";

import { matchModels } from "../../utils";
import { LOCAL_FOOTNOTE_IMPORTED_IDS } from "../markdown/local-footnote-import";

export const replaceIdMiddleware =
  (
    idGenerator: () => string,
    retainedIds?: ReadonlyMap<string, string>,
  ): TransformerMiddleware =>
  ({ slots, docCRUD, assetsManager, adapterConfigs }) => {
    // Replacement owners can retain one native identity without losing local
    // incoming references to that block. All other IDs use normal allocation.
    const idMap = new Map<string, string>(retainedIds);

    // After Import

    const afterImportBlock$ = slots.afterImport.pipe(
      filter(
        (payload): payload is AfterImportBlockPayload =>
          payload.type === "block",
      ),
      map(({ model }) => model),
    );

    // New imported documents and not-yet-live local targets follow regenerated
    // IDs. Native copies pointing at an existing live block keep that target.
    const replaceLinkedPageIdSubscription = afterImportBlock$
      .pipe(
        filter((model) =>
          matchModels(model, [
            ParagraphBlockModel,
            ListBlockModel,
            CalloutBlockModel,
            TableBlockModel,
          ]),
        ),
      )
      .subscribe((model) => {
        const texts: Text[] = matchModels(model, [TableBlockModel])
          ? Object.values(model.props.cells).map(({ text }) => text)
          : [
              model.props.text,
              ...(matchModels(model, [CalloutBlockModel]) && model.props.title
                ? [model.props.title]
                : []),
            ];
        for (const text of texts) {
          let prev = 0;
          const delta: DeltaOperation[] = [];
          for (const d of text.toDelta()) {
            const attributes = d.attributes;
            const reference = attributes?.reference;
            if (
              reference?.pageId &&
              !attributes?.annotation &&
              !attributes?.code &&
              !attributes?.latex
            ) {
              const newId = idMap.get(reference.pageId);
              const oldBlockIds = reference.params?.blockIds;
              const blockIds = Array.isArray(oldBlockIds)
                ? oldBlockIds.map((id: string) =>
                    newId ||
                    (reference.pageId === model.store.id &&
                      !model.store.hasBlock(id))
                      ? (idMap.get(id) ?? id)
                      : id,
                  )
                : undefined;
              if (
                !newId &&
                !blockIds?.some((id, index) => id !== oldBlockIds[index])
              ) {
                prev += d.insert?.length ?? 0;
                continue;
              }

              if (prev > 0) {
                delta.push({ retain: prev });
              }

              delta.push({
                retain: d.insert?.length ?? 0,
                attributes: {
                  reference: {
                    ...reference,
                    pageId: newId ?? reference.pageId,
                    ...(blockIds
                      ? { params: { ...reference.params, blockIds } }
                      : {}),
                  },
                },
              });
              prev = 0;
            } else {
              prev += d.insert?.length ?? 0;
            }
          }
          if (delta.length > 0) {
            text.applyDelta(delta);
          }
        }
      });

    const replaceSurfaceRefIdSubscription = afterImportBlock$
      .pipe(filter((model) => matchModels(model, [SurfaceRefBlockModel])))
      .subscribe((model) => {
        const original = model.props.reference;
        // If there exists a replacement, replace the reference with the new id.
        // Otherwise,
        // 1. If the reference is an affine:frame not in doc, generate a new id.
        // 2. If the reference is graph, keep the original id.
        if (idMap.has(original)) {
          model.props.reference = idMap.get(original)!;
        } else if (
          model.props.refFlavour === "myoxus:frame" &&
          !model.store.hasBlock(original)
        ) {
          const newId = idGenerator();
          idMap.set(original, newId);
          model.props.reference = newId;
        }
      });

    // TODO(@fundon): process linked block/element
    const replaceLinkedDocIdSubscription = afterImportBlock$
      .pipe(
        filter((model) =>
          matchModels(model, [EmbedLinkedDocModel, EmbedSyncedDocModel]),
        ),
      )
      .subscribe((model) => {
        const original = model.props.pageId;
        // If the pageId is not in the doc, generate a new id.
        // If we already have a replacement, use it.
        if (!docCRUD.get(original)) {
          if (idMap.has(original)) {
            model.props.pageId = idMap.get(original)!;
          } else {
            const newId = idGenerator();
            idMap.set(original, newId);
            model.props.pageId = newId;
          }
        }
      });

    // Before Import

    const beforeImportPageSubscription = slots.beforeImport
      .pipe(filter((payload) => payload.type === "page"))
      .subscribe((payload) => {
        // Full-document adapters do not use clipboard preparation. Reserve local
        // targets before any child marker is materialized by normal transformers.
        const reserve = (node: BlockSnapshot) => {
          if (
            node.flavour === "myoxus:footnote-definition" &&
            !idMap.has(node.id)
          )
            idMap.set(node.id, idGenerator());
          node.children.forEach(reserve);
        };
        reserve(payload.snapshot.blocks);
        const remap = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            value.forEach(remap);
            return;
          }
          const record = value as Record<string, unknown>;
          const marker = (
            record.attributes as
              { footnote?: { definitionId?: string } } | undefined
          )?.footnote;
          if (marker?.definitionId && idMap.has(marker.definitionId))
            marker.definitionId = idMap.get(marker.definitionId)!;
          Object.values(record).forEach(remap);
        };
        remap(payload.snapshot.blocks);
        if (idMap.has(payload.snapshot.meta.id)) {
          payload.snapshot.meta.id = idMap.get(payload.snapshot.meta.id)!;
          return;
        }
        const newId = idGenerator();
        idMap.set(payload.snapshot.meta.id, newId);
        payload.snapshot.meta.id = newId;
      });

    const beforeImportBlockSubscription = slots.beforeImport
      .pipe(
        filter(
          (payload): payload is BeforeImportBlockPayload =>
            payload.type === "block",
        ),
      )
      .subscribe((payload) => {
        const { snapshot } = payload;
        if (snapshot.flavour === "myoxus:page") {
          const index = snapshot.children.findIndex(
            (c) => c.flavour === "myoxus:surface",
          );
          if (index !== -1) {
            const [surface] = snapshot.children.splice(index, 1);
            snapshot.children.push(surface);
          }
        }

        const original = snapshot.id;
        // Local markers may already have merged into an existing paragraph.
        // Their prepared definition IDs must survive the ordinary block remap.
        const localIds = JSON.parse(
          (adapterConfigs.get(LOCAL_FOOTNOTE_IMPORTED_IDS) as
            string | undefined) ?? "[]",
        ) as string[];
        if (localIds.includes(original)) idMap.set(original, original);
        const retained = retainedIds?.get(original);
        if (retained) idMap.set(original, retained);
        let newId: string;
        if (idMap.has(original)) {
          newId = idMap.get(original)!;
        } else {
          newId = idGenerator();
          idMap.set(original, newId);
        }
        snapshot.id = newId;

        // Should be re-paired.
        if (["myoxus:attachment", "myoxus:image"].includes(snapshot.flavour)) {
          if (!assetsManager.uploadingAssetsMap.has(original)) return;

          const data = assetsManager.uploadingAssetsMap.get(original)!;
          assetsManager.uploadingAssetsMap.set(newId, data);
          assetsManager.uploadingAssetsMap.delete(original);
          return;
        }

        if (snapshot.flavour === "myoxus:surface") {
          // Generate new IDs for images and frames in advance.
          snapshot.children.forEach((child) => {
            const original = child.id;
            if (idMap.has(original)) {
              newId = idMap.get(original)!;
            } else {
              newId = idGenerator();
              idMap.set(original, newId);
            }
          });

          Object.entries(
            snapshot.props.elements as Record<string, Record<string, unknown>>,
          ).forEach(([_, value]) => {
            switch (value.type) {
              case "connector": {
                let connection = value.source as Record<string, string>;
                if (idMap.has(connection.id)) {
                  const newId = idMap.get(connection.id);
                  if (!newId) {
                    throw new VirgultumError(
                      VirgultumError.ErrorCode.TransformerError,
                      `reference id must exist: ${connection.id}`,
                    );
                  }
                  connection.id = newId;
                }
                connection = value.target as Record<string, string>;
                if (idMap.has(connection.id)) {
                  const newId = idMap.get(connection.id);
                  if (!newId) {
                    throw new VirgultumError(
                      VirgultumError.ErrorCode.TransformerError,
                      `reference id must exist: ${connection.id}`,
                    );
                  }
                  connection.id = newId;
                }
                break;
              }
              case "group": {
                const json = (value.children as Record<string, unknown>)
                  .json as Record<string, unknown>;
                Object.entries(json).forEach(([key, value]) => {
                  if (idMap.has(key)) {
                    delete json[key];
                    const newKey = idMap.get(key);
                    if (!newKey) {
                      throw new VirgultumError(
                        VirgultumError.ErrorCode.TransformerError,
                        `reference id must exist: ${key}`,
                      );
                    }
                    json[newKey] = value;
                  }
                });
                break;
              }
              default:
                break;
            }
          });
        }
      });

    return () => {
      replaceLinkedPageIdSubscription.unsubscribe();
      replaceSurfaceRefIdSubscription.unsubscribe();
      replaceLinkedDocIdSubscription.unsubscribe();
      beforeImportPageSubscription.unsubscribe();
      beforeImportBlockSubscription.unsubscribe();
    };
  };
