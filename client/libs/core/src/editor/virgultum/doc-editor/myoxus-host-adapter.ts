// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `myoxus-host-adapter.ts` - the Myoxus-Core implementation of the
 * Virgultum `MyoxusHostService` contract.
 *
 * The adapter delegates to Myoxus services for
 * host capabilities (event dialogs, calendar resolution,
 * feature flags, workspace context, BPMN host actions, ...). It is
 * constructed in `lit-adaper.tsx` and bound to the editor's
 * `BlockStdScope` via `MyoxusHostExtension`. Virgultum blocks
 * consume the service via `std.get(MyoxusHostServiceIdentifier)`
 * and no longer dispatch `myoxus-event-block-*` /
 * `myoxus-bpmn-block-*` host events.
 *
 * Capabilities covered by this implementation:
 *  - OpenEventEditDialog           (WorkspaceDialogService "event-edit")
 *  - ResolveEventData              (authoritative workspace-event lookup)
 *  - ConfirmEventBlockRemoval      (reference/delete choice dialog)
 *  - ImageProxyUrl                 (capability flag only; the URL
 *                                   is set on `ImageProxyService` at
 *                                   editor mount time, see B-03)
 *  - FeatureFlags                  (FeatureFlagService)
 *  - WorkspaceContext              (WorkspaceService)
 *  - BpmnEditorSession             (leased workspace session and dialog)
 *
 * The adapter is intentionally narrow: the BPMN capability is advertised
 * only when its real workspace service is bound. The B-01
 * `NullMyoxusHostService` is the safety net for unbinding (e.g.
 * inside a unit test that does not bind Core services).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B (P-VIRG-ARCH-B-02)
 */

import type { BlockStdScope } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import {
  type MyoxusConfirmEventRemovalRequest,
  MyoxusHostCapability,
  type MyoxusHostService,
  MyoxusHostServiceIdentifier,
  type MyoxusOpenEventEditDialogArgs,
  type MyoxusResolvedEvent,
  type MyoxusResolveEventRequest,
} from "@virgultum/shared/services";

import type { WorkspaceDialogService } from "../../../modules/dialogs";
import type { DocsService } from "../../../modules/doc";
import type { FeatureFlagService } from "../../../modules/feature-flag";
import type { IntegrationService } from "../../../modules/integration";
import type { ServerService } from "../../../modules/server";
import type { TemplateDocService } from "../../../modules/template-doc";
import type { WorkspaceService } from "../../../modules/workspace";
import type { BpmnEditorService } from "../../../modules/bpmn-editor/session";
import type { View } from "../../../modules/workbench/entities/view";
import { templateVariableCapabilities } from "../../../modules/doc/services/template-variables";

/**
 * The Core-side handles and workspace metadata needed to construct
 * the host service. Captured at editor mount time so the adapter
 * stays stable across re-renders.
 */
export interface MyoxusHostAdapterDeps {
  bpmnEditorService?: BpmnEditorService;
  bpmnEditorView?: View;
  store: Store;
  workspaceService: WorkspaceService;
  workspaceDialogService: WorkspaceDialogService;
  featureFlagService: FeatureFlagService;
  integrationService: IntegrationService;
  docsService: DocsService;
  serverService: ServerService;
  templateDocService: TemplateDocService;
  openTemplateVariablePicker?: MyoxusHostService["openTemplateVariablePicker"];
  openBuildingBlockPicker?: MyoxusHostService["openBuildingBlockPicker"];
  saveBuildingBlockSelection?: MyoxusHostService["saveBuildingBlockSelection"];
}

/**
 * Resolve event data through the workspace calendar integration. The entity
 * owns the local read-through cache and falls back to the authoritative
 * server query when a referenced event has not been loaded yet.
 */
async function resolveEventData(
  integrationService: IntegrationService,
  eventId: string,
): Promise<MyoxusResolvedEvent | null> {
  try {
    const event =
      await integrationService.calendar.resolveEventDetails(eventId);
    if (!event) return null;
    let tagColor = event.tagId
      ? (integrationService.calendar.tags$.value.find(
          (tag) => tag.id === event.tagId,
        )?.color ?? null)
      : null;
    if (event.tagId && !tagColor) {
      try {
        const tags = await integrationService.calendar.listTags();
        tagColor = tags.find((tag) => tag.id === event.tagId)?.color ?? null;
      } catch {
        tagColor = null;
      }
    }
    return {
      title: event.title ?? "",
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      tagColor,
    };
  } catch (error) {
    console.warn("[myoxus-host] event resolution failed", { eventId, error });
    return null;
  }
}

/**
 * Construct a `MyoxusHostService` backed by the supplied Myoxus Core
 * services. The returned service captures the services by reference,
 * so workspace switches require a fresh adapter (the editor's
 * `lit-adaper` rebuilds it whenever `workspaceId` changes).
 */
export function createMyoxusHostServiceAdapter(
  deps: MyoxusHostAdapterDeps,
): MyoxusHostService {
  const {
    workspaceService,
    workspaceDialogService,
    featureFlagService,
    integrationService,
    serverService,
  } = deps;

  const capabilities = new Set<MyoxusHostCapability>([
    MyoxusHostCapability.OpenEventEditDialog,
    MyoxusHostCapability.ResolveEventData,
    MyoxusHostCapability.ConfirmEventBlockRemoval,
    MyoxusHostCapability.ImageProxyUrl,
    MyoxusHostCapability.FeatureFlags,
    MyoxusHostCapability.WorkspaceContext,
  ]);

  // No fallback capability: an absent session owner must fail visibly.
  if (deps.bpmnEditorService)
    capabilities.add(MyoxusHostCapability.BpmnEditorSession);

  return {
    capabilities,
    isTemplateDocument() {
      return (
        deps.templateDocService.list.isTemplate$(deps.store.id).value === true
      );
    },

    getTemplateVariableCapabilities() {
      return templateVariableCapabilities;
    },

    openTemplateVariablePicker: deps.openTemplateVariablePicker,
    openBuildingBlockPicker: deps.openBuildingBlockPicker,
    saveBuildingBlockSelection: deps.saveBuildingBlockSelection,

    async openEventEditDialog(
      args: MyoxusOpenEventEditDialogArgs,
    ): Promise<string | null> {
      const workspaceId = args.workspaceId ?? workspaceService.workspace.id;
      if (workspaceId !== workspaceService.workspace.id) return null;
      if (args.eventId) {
        const event = await integrationService.calendar.resolveEventDetails(
          args.eventId,
        );
        if (!event) return null;
      }
      return new Promise<string | null>((resolve) => {
        workspaceDialogService.open(
          "event-edit",
          {
            eventId: args.eventId,
            sourceDocId: args.sourceDocId,
          },
          (eventId) => resolve(eventId ?? null),
        );
      });
    },

    async resolveEventData(
      request: MyoxusResolveEventRequest,
    ): Promise<MyoxusResolvedEvent | null> {
      if (request.workspaceId !== workspaceService.workspace.id) return null;
      return resolveEventData(integrationService, request.eventId);
    },

    confirmEventBlockRemoval(
      request: MyoxusConfirmEventRemovalRequest,
    ): Promise<boolean> {
      if (request.workspaceId !== workspaceService.workspace.id) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        workspaceDialogService.open(
          "event-block-remove",
          { eventId: request.eventId },
          (confirmed) => resolve(confirmed === true),
        );
      });
    },

    hasImageProxyUrl(): boolean {
      try {
        const url = new URL(
          BUILD_CONFIG.imageProxyUrl,
          serverService.server.baseUrl,
        );
        return url.toString().length > 0;
      } catch {
        return false;
      }
    },

    isFeatureEnabled(flag: string): boolean {
      const flags = featureFlagService.flags as unknown as Record<
        string,
        { value?: boolean } | undefined
      >;
      const entry = flags[flag];
      if (!entry) return false;
      return entry.value === true;
    },

    getWorkspaceId(): string {
      return workspaceService.workspace.id;
    },

    openBpmnEditor: deps.bpmnEditorService
      ? (request) => {
          if (request.docId !== deps.store.id)
            return Promise.reject(new Error("BPMN_DOCUMENT_MISMATCH"));
          return deps.bpmnEditorService!.open(
            request,
            deps.store.readonly,
            deps.bpmnEditorView,
          );
        }
      : undefined,
  };
}

/**
 * Convenience: bind a `MyoxusHostService` to a `BlockStdScope`'s
 * container by registering it under the `MyoxusHostServiceIdentifier`
 * key. Useful in tests; production code wires the extension through
 * `MyoxusHostExtension` so the binding travels with the scope's
 * lifecycle.
 */
export function bindMyoxusHostService(
  scope: BlockStdScope,
  service: MyoxusHostService,
): void {
  const container = scope.container as unknown as {
    addImpl: (identifier: unknown, factory: () => unknown) => void;
  };
  container.addImpl(MyoxusHostServiceIdentifier, () => service);
}
