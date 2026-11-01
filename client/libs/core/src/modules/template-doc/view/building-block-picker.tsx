// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Alert,
  Button,
  Group,
  Modal,
  MyoxusText,
  MyoxusTextInput,
  notify,
  Stack,
} from "@myoxus/ui-facade";
import {
  BlockSelection,
  TextSelection,
  type BlockStdScope,
} from "@virgultum/editor/std";
import { Slice } from "@virgultum/editor/store";
import {
  getSelectedModelsCommand,
  draftSelectedModelsCommand,
} from "@virgultum/editor/shared/commands";
import { useCallback, useEffect, useRef, useState } from "react";

import { useRegionalPreferences } from "../../../components/hooks/myoxus/use-user-preferences";
import {
  BuildingBlockTargetError,
  captureBuildingBlockTarget,
  restoreBuildingBlockTarget,
  type BuildingBlockTarget,
} from "../../../editor/virgultum/doc-editor/building-block-target";
import { DocsService } from "../../doc";
import { WorkspaceService } from "../../workspace";
import { GuardService } from "../../permissions";
import { WorkbenchService } from "../../workbench";
import { templateFailureMessages } from "../services/template-application";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "../services/template-instantiation-error";
import { TemplateSectionInsertionService } from "../services/template-section-insertion";
import type {
  TemplateCatalogRouteState,
  TemplateCatalogRow,
} from "./catalog-model";
import { TemplateCatalogInventoryContent } from "./catalog-page";

const targetMessages = {
  readonly: "com.myoxus.templates.blocks.readonly",
  "table-cell": "com.myoxus.templates.blocks.table-cell",
  "no-body": "com.myoxus.templates.blocks.no-body",
  "stale-target": "com.myoxus.templates.blocks.stale-target",
} as const;

type SelectionCapture = Awaited<
  ReturnType<BlockStdScope["clipboard"]["prepareCopySlice"]>
>;

function SaveBuildingBlockSelection({
  capture,
  std,
  onClosed,
}: {
  capture: SelectionCapture;
  std: BlockStdScope;
  onClosed: () => void;
}) {
  const t = useI18n();
  const docs = useService(DocsService);
  const guard = useService(GuardService);
  const workbench = useService(WorkbenchService).workbench;
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => capture[Symbol.dispose](), [capture]);
  const save = async () => {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      await capture.assertCurrent();
      if (
        !(await guard.can("Doc_Read", std.store.id)) ||
        !(await guard.can("Workspace_CreateDoc"))
      )
        throw new TemplateInstantiationError("source-unavailable");
      const record = await docs.createTemplateDoc(
        {
          title: name.trim(),
          body: capture.snapshot,
          classification: { category: "building-blocks", tags: [] },
        },
        "custom",
      );
      onClosed();
      workbench.openDoc(record.id, { at: "active" });
    } catch {
      setError(t["com.myoxus.template-application.error.failed"]());
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open
      persistent={pending}
      title={t["com.myoxus.templates.blocks.save-selection"]()}
      onOpenChange={(open) => {
        if (!open) onClosed();
      }}
    >
      <Stack
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <MyoxusTextInput
          label={t["admin.common.name"]()}
          value={name}
          onChange={setName}
          disabled={pending}
          data-autofocus
          required
        />
        {error ? <Alert role="alert" title={error} /> : null}
        <Group justify="flex-end">
          <Button variant="secondary" disabled={pending} onClick={onClosed}>
            {t.Cancel()}
          </Button>
          <Button
            type="submit"
            disabled={pending || !name.trim()}
            loading={pending}
          >
            {t.Save()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function BuildingBlockPicker({
  target,
  onClosed,
}: {
  target: BuildingBlockTarget;
  onClosed: () => void;
}) {
  const t = useI18n();
  const preferences = useRegionalPreferences();
  const insertion = useService(TemplateSectionInsertionService);
  const workspace = useService(WorkspaceService).workspace;
  const docs = useService(DocsService);
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<TemplateCatalogRouteState>({
    type: "building-blocks",
    tag: null,
    search: "",
    origin: "all",
    sort: "name-asc",
  });
  const [source, setSource] = useState<string | null>(null);
  const [selected, setSelected] = useState<TemplateCatalogRow>();
  const onSelected = useCallback((row: TemplateCatalogRow | undefined) => {
    setSelected(row);
    if (row?.docId) setSource((current) => current ?? row.docId);
  }, []);
  const [preview, setPreview] = useState<{
    docId: string;
    revision: Uint8Array;
  } | null>(null);
  const onPreview = useCallback(
    (docId: string, revision: Uint8Array | null) => {
      setPreview((previous) =>
        revision
          ? { docId, revision }
          : previous?.docId === docId
            ? null
            : previous,
      );
    },
    [],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const failureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error && !pending) failureRef.current?.focus();
  }, [error, pending]);
  const committed = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const insert = async (choice = selected) => {
    if (
      pending ||
      (!committed.current &&
        (!choice?.docId ||
          !choice.available ||
          preview?.docId !== choice.docId))
    )
      return;
    const controller = new AbortController();
    abort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    setPending(true);
    setError(null);
    try {
      if (committed.current) {
        // A lost acknowledgement must never replay the native insertion.
        await waitForTemplateOperation(
          workspace.engine.doc.waitForSynced(target.docId, signal),
          signal,
        );
      } else {
        await insertion.insert(
          choice!.docId!,
          preview!.revision,
          target,
          preferences,
          signal,
          () => {
            committed.current = true;
          },
        );
      }
      setOpen(false);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (committed.current) {
        setUncertain(true);
        setError(t["com.myoxus.templates.blocks.confirmation-pending"]());
      } else {
        setError(
          cause instanceof BuildingBlockTargetError
            ? t[targetMessages[cause.reason]]()
            : cause instanceof TemplateInstantiationError
              ? t[
                  cause.reason === "conflict"
                    ? "com.myoxus.templates.preview.changed"
                    : templateFailureMessages[cause.reason]
                ]()
              : t["com.myoxus.template-application.error.failed"](),
        );
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      open={open}
      width="100%"
      height="100%"
      title={t["com.myoxus.templates.blocks.insert"]()}
      persistent={pending}
      onOpenChange={setOpen}
      contentOptions={{
        "data-testid": "building-block-picker",
        onKeyDown: (event) => event.stopPropagation(),
      }}
      onExitTransitionEnd={() => {
        try {
          if (committed.current) target.std.host.focus({ preventScroll: true });
          else restoreBuildingBlockTarget(target);
        } catch {
          /* A closed editor cannot receive focus. */
        }
        onClosed();
      }}
    >
      <Stack
        component="form"
        h="100%"
        mih={0}
        onSubmit={(event) => {
          event.preventDefault();
          void insert();
        }}
      >
        <MyoxusText tone="secondary">
          {t["com.myoxus.templates.blocks.destination"]({
            title: docs.list.doc$(target.docId).value?.title$.value ?? "",
          })}
        </MyoxusText>
        <TemplateCatalogInventoryContent
          picker={{
            state,
            source,
            onStateChange: setState,
            onSelect: setSource,
            onSelected,
            onConfirm: (row) => void insert(row),
            onPreview,
          }}
        />
        {error ? (
          <Alert ref={failureRef} tabIndex={-1} role="alert" title={error} />
        ) : null}
        <Group justify="flex-end">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            {t[uncertain ? "admin.actions.close" : "Cancel"]()}
          </Button>
          <Button
            type="submit"
            disabled={
              pending ||
              (!uncertain &&
                (!selected?.available || preview?.docId !== selected.docId))
            }
            loading={pending}
          >
            {t[
              uncertain
                ? "com.myoxus.templates.blocks.check-confirmation"
                : target.afterSelection
                  ? "com.myoxus.templates.blocks.insert-after-selection"
                  : "com.myoxus.common.insert"
            ]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Page, Edgeless and Electron share this host binding and native writer. */
export function useBuildingBlockPicker() {
  const t = useI18n();
  const [target, setTarget] = useState<BuildingBlockTarget | null>(null);
  const [saved, setSaved] = useState<{
    std: BlockStdScope;
    capture: SelectionCapture;
  } | null>(null);
  const preparing = useRef(false);
  const saveBuildingBlockSelection = useCallback(
    (std: BlockStdScope) => {
      if (preparing.current) return;
      preparing.current = true;
      void (async () => {
        try {
          const text = std.selection.find(TextSelection);
          if (
            std.store.readonly ||
            (!(text && !text.isCollapsed()) &&
              !std.selection.filter(BlockSelection).length)
          )
            throw new Error("No native body selection");
          const [ok, result] = std.command
            .chain()
            .pipe(getSelectedModelsCommand, {
              types: ["text", "block"],
              mode: "flat",
            })
            .pipe(draftSelectedModelsCommand)
            .run();
          if (!ok || !result.draftedModels)
            throw new Error("No native selection");
          const models = await result.draftedModels;
          if (
            !models.length ||
            models.some((model) => {
              let current = std.store.getBlock(model.id)?.model ?? null;
              while (current && current.flavour !== "myoxus:note")
                current = std.store.getParent(current);
              return !current;
            })
          )
            throw new Error("Selection is outside an editable body");
          const capture = await std.clipboard.prepareCopySlice(
            Slice.fromModels(std.store, models),
          );
          try {
            await capture.assertCurrent();
            if (!std.host.isConnected) throw new Error("Editor closed");
            setSaved({ std, capture });
          } catch (cause) {
            capture[Symbol.dispose]();
            throw cause;
          }
        } catch {
          preparing.current = false;
          notify.error({
            title: t["com.myoxus.templates.blocks.save-selection"](),
            message: t["com.myoxus.templates.blocks.select-body"](),
          });
        }
      })();
    },
    // Changing this host command when the dialog opens would rebuild the
    // editor extension and dispose the captured native clipboard job.
    [t],
  );
  const openBuildingBlockPicker = useCallback(
    (std: BlockStdScope) => {
      try {
        setTarget(captureBuildingBlockTarget(std));
      } catch (cause) {
        notify.error({
          title: t["com.myoxus.templates.blocks.insert"](),
          message:
            cause instanceof BuildingBlockTargetError
              ? t[targetMessages[cause.reason]]()
              : t["com.myoxus.templates.blocks.no-body"](),
        });
      }
    },
    [t],
  );
  return {
    openBuildingBlockPicker,
    saveBuildingBlockSelection,
    buildingBlockPicker: (
      <>
        {target ? (
          <BuildingBlockPicker
            target={target}
            onClosed={() => setTarget(null)}
          />
        ) : null}
        {saved ? (
          <SaveBuildingBlockSelection
            {...saved}
            onClosed={() => {
              preparing.current = false;
              setSaved(null);
            }}
          />
        ) : null}
      </>
    ),
  };
}
