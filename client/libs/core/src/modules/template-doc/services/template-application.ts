// SPDX-License-Identifier: AGPL-3.0-or-later

import { I18n } from "@myoxus/i18n";
import { LiveData, Service } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";

import type { TemplateInputPromptService } from "./template-input-prompt";
import type { WorkbenchService } from "../../workbench";
import type {
  InstantiateTemplateOptions,
  TemplateInstantiationService,
} from "./template-instantiation";
import {
  TemplateInstantiationError,
  type TemplateInstantiationFailure,
} from "./template-instantiation-error";

export const templateFailureMessages = {
  "repeat-invalid": "com.myoxus.template-application.error.repeat",
  "invalid-syntax": "com.myoxus.template-application.error.variables",
  "unresolved-variable": "com.myoxus.template-application.error.variables",
  "source-unavailable": "com.myoxus.template-application.error.unavailable",
  "building-block-source": "com.myoxus.templates.library.blocks.purpose",
  "default-in-use": "com.myoxus.templates.classification.default-in-use",
  "managed-source": "com.myoxus.templates.classification.managed-source",
  "source-is-target": "com.myoxus.template-application.error.variables",
  "local-only-incompatible": "com.myoxus.template-application.error.local",
  "workspace-unavailable": "com.myoxus.template-application.error.unavailable",
  "organization-unavailable":
    "com.myoxus.template-application.error.organization",
  "owner-unit-unavailable": "com.myoxus.template-application.error.owner-unit",
  "parent-unavailable": "com.myoxus.template-application.error.parent",
  "folder-absent": "com.myoxus.template-application.error.folder-absent",
  "folder-ambiguous": "com.myoxus.template-application.error.folder-ambiguous",
  "metadata-unavailable": "com.myoxus.template-application.error.unavailable",
  "creator-unavailable": "com.myoxus.template-application.error.unavailable",
  "creation-time-unavailable":
    "com.myoxus.template-application.error.unavailable",
  "member-fetch": "com.myoxus.template-application.error.members",
  "empty-field": "com.myoxus.template-application.error.unavailable",
  "sync-timeout": "com.myoxus.template-application.error.interrupted",
  cancelled: "com.myoxus.template-application.error.interrupted",
  conflict: "com.myoxus.template-application.error.conflict",
  "rollback-failed": "com.myoxus.template-application.error.restoration",
  "application-failed": "com.myoxus.template-application.error.failed",
} as const satisfies Record<TemplateInstantiationFailure, string>;

export type TemplateApplicationResult =
  | { ok: true; docId: string }
  | { ok: false; reason: TemplateInstantiationFailure | "busy" };

export type TemplateApplicationAction =
  "sidebar" | "all-pages" | "collection" | "mobile" | "journal" | "library";

/** User feedback and single-flight only; content, authority and rollback remain in the instantiator. */
export class TemplateApplicationService extends Service {
  readonly pending$ = new LiveData<ReadonlySet<string>>(new Set());

  constructor(
    private readonly instantiation: TemplateInstantiationService,
    private readonly workbenchService: WorkbenchService,
    private readonly inputPrompt: TemplateInputPromptService,
  ) {
    super();
  }

  async updatePageDefault(id?: string) {
    await this.updateDefault(() => this.instantiation.updatePageDefault(id));
  }

  async updateJournalDefault(id?: string) {
    await this.updateDefault(() => this.instantiation.updateJournalDefault(id));
  }

  private async updateDefault(update: () => Promise<void>) {
    try {
      await update();
    } catch (error) {
      notify.error({
        title: I18n["Template"](),
        message:
          error instanceof TemplateInstantiationError &&
          error.reason === "invalid-syntax"
            ? I18n["com.myoxus.template-input.journal-restriction"]()
            : error instanceof TemplateInstantiationError
              ? I18n[templateFailureMessages[error.reason]]()
              : I18n["com.myoxus.template-application.error.unavailable"](),
      });
    }
  }

  static targetKey(docId: string) {
    return `target:${docId}`;
  }

  static creationKey(action: TemplateApplicationAction, sourceDocId?: string) {
    return action === "library" && sourceDocId
      ? `create:${action}:${sourceDocId}`
      : `create:${action}`;
  }

  async apply(
    sourceDocId: string,
    options: InstantiateTemplateOptions,
    creationAction: TemplateApplicationAction,
  ): Promise<TemplateApplicationResult> {
    const key = options.targetDocId
      ? TemplateApplicationService.targetKey(options.targetDocId)
      : TemplateApplicationService.creationKey(creationAction, sourceDocId);
    // Do not return the first promise: a second caller must not repeat success
    // navigation/tracking after the original operation finishes.
    if (this.pending$.value.has(key)) return { ok: false, reason: "busy" };
    this.pending$.setValue(new Set([...this.pending$.value, key]));
    try {
      return {
        ok: true,
        docId:
          creationAction === "journal"
            ? await this.instantiation.instantiate(sourceDocId, options)
            : await this.inputPrompt.run((requestInputs, signal) =>
                this.instantiation.instantiate(sourceDocId, {
                  ...options,
                  requestInputs,
                  signal,
                }),
              ),
      };
    } catch (cause) {
      const error =
        cause instanceof TemplateInstantiationError
          ? cause
          : new TemplateInstantiationError("application-failed", { cause });
      if (error.reason === "cancelled")
        return { ok: false, reason: "cancelled" };
      const recoverId =
        error.reason === "rollback-failed" ? error.targetDocId : undefined;
      notify.error(
        {
          title: I18n["Template"](),
          message: I18n[templateFailureMessages[error.reason]](),
          ...(recoverId
            ? {
                actions: [
                  {
                    label: I18n["com.myoxus.workspace-pages.action.open"](),
                    onClick: () =>
                      this.workbenchService.workbench.openDoc(recoverId),
                  },
                ],
              }
            : {}),
        },
        error.reason === "rollback-failed" ? { duration: 0 } : undefined,
      );
      return { ok: false, reason: error.reason };
    } finally {
      const pending = new Set(this.pending$.value);
      pending.delete(key);
      this.pending$.setValue(pending);
    }
  }
}
