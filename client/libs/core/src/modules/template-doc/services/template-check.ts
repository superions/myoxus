// SPDX-License-Identifier: AGPL-3.0-or-later

import { LiveData, Service } from "@myoxus/infra";
import type { DocsService } from "../../doc/services/docs";
import type {
  TemplateCheckDiagnostic,
  TemplateCheckResult,
} from "../../doc/services/docs";
import type { TemplateDocService } from "./template-doc";
import { waitForTemplateOperation } from "./template-instantiation-error";

/** Shared Web/Electron read boundary and transient, revision-bound navigation.
 * Application, prompts, creation and idempotency owners are never called here.
 */
export class TemplateCheckService extends Service {
  readonly location$ = new LiveData<{
    result: TemplateCheckResult;
    diagnostic: TemplateCheckDiagnostic;
  } | null>(null);
  constructor(
    private readonly docs: DocsService,
    private readonly templates: TemplateDocService,
  ) {
    super();
  }

  async check(sourceDocId: string, signal: AbortSignal) {
    await waitForTemplateOperation(
      this.templates.resolveSourceMetadataForDoc(sourceDocId, signal),
      signal,
    );
    const result = await this.docs.checkTemplate(sourceDocId, signal);
    try {
      await waitForTemplateOperation(
        this.templates.resolveSourceMetadataForDoc(sourceDocId, signal),
        signal,
      );
      return result;
    } catch (error) {
      result.release();
      throw error;
    }
  }

  locate(result: TemplateCheckResult, diagnostic: TemplateCheckDiagnostic) {
    if (!result.isCurrent()) return false;
    this.location$.setValue({ result, diagnostic });
    return true;
  }
}
