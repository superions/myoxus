// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { DocsService } from "@myoxus/core/modules/doc";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import {
  WorkspaceServerService,
  GraphQLService,
} from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { documentFieldPresentationsQuery } from "@myoxus/graphql";
import { UserFriendlyError } from "@myoxus/error";
import { firstValueFrom, timeout } from "rxjs";
import { useFramework } from "@myoxus/infra";
import { type Store } from "@virgultum/editor/store";
import { type DocumentField } from "@virgultum/editor/shared/types";
import { observeDocumentFields } from "./document-field-observer";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

type MetadataField = Extract<DocumentField, { type: "metadata" }>;
const noMetadataFields: MetadataField[] = [];
type FieldValue = {
  state: "VALUE" | "UNSET" | "UNAVAILABLE";
  text: string | null;
  descriptor: string;
};
type Projection =
  | {
      state: "pending" | "unavailable" | "offline" | "denied";
      values: ReadonlyMap<string, FieldValue>;
    }
  | {
      state: "ready";
      values: ReadonlyMap<string, FieldValue>;
    };

interface DocumentFieldPresentation {
  template: boolean | null;
  projection: Projection;
  preferences: ReturnType<typeof useRegionalPreferences>;
  verifyMetadata: (field: MetadataField, displayed: string) => Promise<boolean>;
  openMetadata?: (
    returnFocusRef: RefObject<HTMLElement | null>,
    readonly: boolean,
  ) => void;
}

const DocumentFieldPresentationContext =
  createContext<DocumentFieldPresentation | null>(null);

/** An isolated source preview shows definitions and defaults, never source facts. */
export function DocumentFieldSourcePreviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const preferences = useRegionalPreferences();
  const value = useMemo<DocumentFieldPresentation>(
    () => ({
      template: true,
      preferences,
      projection: { state: "pending", values: new Map() },
      verifyMetadata: async () => false,
    }),
    [preferences],
  );
  return (
    <DocumentFieldPresentationContext.Provider value={value}>
      {children}
    </DocumentFieldPresentationContext.Provider>
  );
}

/** One mounted editor observes native field owners without exporting or writing
 * document content, and resolves its live metadata in one batched projection.
 */
export function DocumentFieldPresentationProvider({
  page,
  snapshot,
  children,
}: {
  page: Store;
  snapshot?: boolean;
  children: ReactNode;
}) {
  const framework = useFramework();
  const preferences = useRegionalPreferences();
  const preferenceKey = JSON.stringify(preferences);
  const [template, setTemplate] = useState<boolean | null>(null);
  const [observed, setObserved] = useState<{
    page: Store;
    fields: MetadataField[];
  }>();
  // A document switch must not query the new document with the previous owner's
  // descriptors while effect cleanup and its initial observation are pending.
  const fields = observed?.page === page ? observed.fields : noMetadataFields;
  const [projection, setProjection] = useState<Projection>({
    state: "pending",
    values: new Map(),
  });

  useEffect(() => {
    if (snapshot) return;
    const docs = framework.get(DocsService);
    let inner: { unsubscribe(): void } | undefined;
    const outer = docs.list.doc$(page.id).subscribe((record) => {
      inner?.unsubscribe();
      if (!record) {
        setTemplate(null);
        return;
      }
      inner = record.isTemplate$.subscribe((value) =>
        setTemplate(value ?? null),
      );
    });
    return () => {
      inner?.unsubscribe();
      outer.unsubscribe();
    };
  }, [framework, page, snapshot]);

  useEffect(() => {
    if (snapshot) return;
    return observeDocumentFields(
      page,
      (fields) => setObserved({ page, fields }),
      () => {
        setObserved({ page, fields: [] });
        setProjection({
          state: "unavailable",
          values: new Map(),
        });
      },
    );
  }, [page, snapshot]);

  useEffect(() => {
    if (snapshot || template !== false || fields.length === 0) return;
    const workspace = framework.get(WorkspaceService).workspace;
    const graphql = framework
      .get(WorkspaceServerService)
      .server?.scope.get(GraphQLService);
    if (workspace.flavour === "local" || !graphql) {
      setProjection({ state: "offline", values: new Map() });
      return;
    }
    const cache = framework.get(DocumentMetadataCacheService);
    let closed = false;
    let active: AbortController | undefined;
    let subscription: { unsubscribe(): void } | undefined;
    let syncSubscription: { unsubscribe(): void } | undefined;
    let syncReady: boolean | undefined;
    const initial = new AbortController();
    const fail = (error: unknown) => {
      const friendly = UserFriendlyError.fromAny(error);
      const denied =
        friendly.isStatus(403) ||
        friendly.code === "FORBIDDEN" ||
        friendly.code === "UNAUTHORIZED";
      setProjection({
        state: !navigator.onLine
          ? "offline"
          : denied
            ? "denied"
            : "unavailable",
        values: new Map(),
      });
    };
    const refresh = () => {
      active?.abort();
      if (syncReady === false || !navigator.onLine) {
        setProjection({
          state: navigator.onLine ? "pending" : "offline",
          values: new Map(),
        });
        return;
      }
      const controller = new AbortController();
      active = controller;
      setProjection({ state: "pending", values: new Map() });
      void graphql
        .gql({
          query: documentFieldPresentationsQuery,
          variables: { workspaceId: workspace.id, docId: page.id, fields },
          context: {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(30_000),
            ]),
          },
        })
        .then((result) => {
          if (closed || controller.signal.aborted) return;
          if (result.documentFieldPresentations.length !== fields.length)
            throw new Error("Field presentation count mismatch");
          setProjection({
            state: "ready",
            values: new Map(
              fields.map((field, index) => [
                field.id,
                {
                  ...result.documentFieldPresentations[index],
                  descriptor: JSON.stringify(field),
                },
              ]),
            ),
          });
        })
        .catch((error: unknown) => {
          if (!closed && !controller.signal.aborted) {
            fail(error);
          }
        });
    };
    const offline = () => {
      active?.abort();
      setProjection({ state: "offline", values: new Map() });
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    // Establish the existing lightweight metadata owner before subscribing;
    // its initial cache fill must not trigger a redundant presentation request.
    void cache
      .hydrateMetadataWhenAvailable(page.id, initial.signal)
      .then((metadata) => {
        if (closed) return;
        // The indexed template flag can still be loading. Never project source
        // facts as if they belonged to the eventual destination document.
        if (metadata.template?.state && metadata.template.state !== "none") {
          setTemplate(true);
          return;
        }
        subscription = cache.watchMetadataChanges(page.id).subscribe(refresh);
        syncSubscription = workspace.engine.doc
          .docState$(page.id)
          .subscribe((sync) => {
            const synced = Boolean(sync.synced);
            const previousSync = syncReady;
            syncReady = synced;
            if (previousSync !== undefined && previousSync !== synced) {
              if (synced) refresh();
              else {
                active?.abort();
                setProjection({ state: "pending", values: new Map() });
              }
            }
          });
        refresh();
      })
      .catch((error: unknown) => {
        if (!closed && !initial.signal.aborted) fail(error);
      });
    return () => {
      closed = true;
      initial.abort();
      active?.abort();
      subscription?.unsubscribe();
      syncSubscription?.unsubscribe();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", refresh);
    };
  }, [fields, framework, page, preferenceKey, snapshot, template]);

  const verifyMetadata = useCallback(
    async (field: MetadataField, displayed: string) => {
      const workspace = framework.get(WorkspaceService).workspace;
      const graphql = framework
        .get(WorkspaceServerService)
        .server?.scope.get(GraphQLService);
      if (
        template !== false ||
        workspace.flavour === "local" ||
        !navigator.onLine ||
        !graphql
      )
        return false;
      try {
        const synced = () =>
          firstValueFrom(
            workspace.engine.doc
              .docState$(page.id)
              .pipe(timeout({ first: 30_000 })),
          );
        if (!(await synced()).synced) return false;
        const result = await graphql.gql({
          query: documentFieldPresentationsQuery,
          variables: {
            workspaceId: workspace.id,
            docId: page.id,
            fields: [field],
          },
          context: { signal: AbortSignal.timeout(30_000) },
        });
        const value = result.documentFieldPresentations[0];
        return Boolean(
          (await synced()).synced &&
          (value?.state === "UNSET"
            ? displayed === "—"
            : value?.state === "VALUE" && value.text === displayed),
        );
      } catch {
        return false;
      }
    },
    [framework, page, template],
  );
  const openMetadata = useCallback(
    (returnFocusRef: RefObject<HTMLElement | null>, readonly: boolean) => {
      framework.get(WorkspaceDialogService).open("doc-info", {
        docId: page.id,
        returnFocusRef,
        readonly,
      });
    },
    [framework, page.id],
  );
  const value = useMemo(
    () => ({
      template,
      projection,
      preferences,
      verifyMetadata,
      openMetadata: snapshot ? undefined : openMetadata,
    }),
    [template, projection, preferences, verifyMetadata, openMetadata, snapshot],
  );
  return (
    <DocumentFieldPresentationContext.Provider value={value}>
      {children}
    </DocumentFieldPresentationContext.Provider>
  );
}

export function useDocumentFieldPresentation() {
  return useContext(DocumentFieldPresentationContext);
}
