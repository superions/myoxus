// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Service } from "@myoxus/infra";

import type { DocsService } from "../../doc";
import {
  buildTemplateVariables,
  type TemplateDateInput,
} from "../../doc/services/template-variables";
import type { RegionalFormatPreferences } from "../../i18n";
import type { TemplateTitlePolicy } from "./source-metadata";
import type { TemplateDocService } from "./template-doc";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "./template-instantiation-error";

import type {
  RequestTemplateInputs,
  TemplateInputValues,
} from "./template-inputs";

export interface InstantiateTemplateOptions {
  inputValues?: TemplateInputValues;
  requestInputs?: RequestTemplateInputs;
  signal?: AbortSignal;
  creationContext: TemplateCreationContext;
  date: TemplateDateInput;
  regionalPreferences: RegionalFormatPreferences;
  targetDocId?: string;
  titlePolicy?: TemplateTitlePolicy | "preserve";
}

/** Facts supplied by the creation action, never inferred from navigation. */
export interface TemplateCreationContext {
  readonly parentDocId?: string;
  readonly folderId?: string;
}

export const resolveTemplateDocumentTitle = ({
  dateLabel,
  sourceTitle,
  titlePolicy,
}: {
  dateLabel: string;
  sourceTitle: string;
  titlePolicy: TemplateTitlePolicy | "preserve";
}): string | undefined => {
  const templateTitle = sourceTitle.trim();
  switch (titlePolicy) {
    case "preserve":
      return undefined;
    case "date":
      return dateLabel;
    case "template-date":
      return templateTitle ? `${templateTitle} · ${dateLabel}` : dateLabel;
    case "template":
      return templateTitle || dateLabel;
  }
};

/**
 * The single application boundary for document templates.
 *
 * Picker ranking and builtin reconciliation remain separate concerns. Once a
 * source template has been selected, every Web/Core creation surface comes
 * through this service so title policy, regional variables and rollback do
 * not drift between Sidebar, Starter Bar and Journal.
 */
export class TemplateInstantiationService extends Service {
  private readonly abort = new AbortController();

  constructor(
    private readonly docsService: DocsService,
    private readonly templateDocService: TemplateDocService,
  ) {
    super();
  }

  override dispose() {
    this.abort.abort(new TemplateInstantiationError("cancelled"));
    super.dispose();
  }

  async updatePageDefault(id?: string): Promise<void> {
    await this.templateDocService.setting.updatePageTemplateDocId(id);
  }

  async updateJournalDefault(id?: string): Promise<void> {
    if (id) {
      const signal = AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(30_000),
      ]);
      if ((await this.docsService.readJournalTemplateInputs(id, signal)).length)
        throw new TemplateInstantiationError("invalid-syntax");
    }
    await this.templateDocService.setting.updateJournalTemplateDocId(id);
  }

  async instantiate(
    sourceDocId: string,
    options: InstantiateTemplateOptions,
  ): Promise<string> {
    const deadline = new AbortController();
    const startTimer = () =>
      setTimeout(
        () => deadline.abort(new TemplateInstantiationError("sync-timeout")),
        30_000,
      );
    let timer = startTimer();
    const signal = AbortSignal.any([
      this.abort.signal,
      deadline.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const source = this.docsService.list.doc$(sourceDocId).value;
      // Selection and application are separate user actions. Re-read the
      // projected source state here so an unmarked or trashed document cannot
      // be applied from a picker snapshot that became stale in between.
      if (
        !source ||
        source.trash$.value ||
        !(await waitForTemplateOperation(
          this.templateDocService.list.isTemplate(sourceDocId),
          signal,
        ))
      ) {
        throw new TemplateInstantiationError("source-unavailable");
      }

      const variables = buildTemplateVariables(
        options.date,
        options.regionalPreferences,
      );
      // This protected value is resolved inside the guarded document operation
      // from the explicit day, not admitted through the legacy variable map.
      delete variables["calendar.iso_week_year"];
      return await this.docsService.applyTemplate({
        sourceDocId,
        targetDocId: options.targetDocId,
        creationContext: { ...options.creationContext },
        title: (sourceTitle, defaultPolicy) =>
          resolveTemplateDocumentTitle({
            sourceTitle,
            dateLabel: variables.date_long,
            titlePolicy: options.titlePolicy ?? defaultPolicy,
          }),
        variables,
        inputValues: options.inputValues,
        requestInputs: options.requestInputs
          ? async (names, inputSignal) => {
              // A human filling the form is not a stalled sync operation.
              clearTimeout(timer);
              try {
                return await options.requestInputs!(names, inputSignal);
              } finally {
                timer = startTimer();
              }
            }
          : undefined,
        regionalPreferences: options.regionalPreferences,
        applicationDate: options.date,
        signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
