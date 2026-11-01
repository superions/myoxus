// SPDX-License-Identifier: MIT
import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { ChatPreferenceMenu } from "./preference-menu";

/** Service adapter only; native React controls share the owning host's providers. */
export class ChatInputPreference extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor session:
    CopilotChatHistoryFragment | null | undefined;
  @property({ attribute: false }) accessor extendedThinking = false;
  @property({ attribute: false }) accessor disabled = false;
  @property({ attribute: false }) accessor onExtendedThinkingChange:
    ((enabled: boolean) => void) | undefined;
  @property({ attribute: false })
  accessor toolsConfigService!: AIToolsConfigService;
  @property({ attribute: false }) accessor aiModelService!: AIModelService;

  override render() {
    if (!this.reactToLit) return nothing;
    const models = this.aiModelService.models.value;
    const config = this.toolsConfigService.config.value;
    return this.reactToLit(
      createElement(ChatPreferenceMenu, {
        models,
        modelId: this.aiModelService.effectiveModelId,
        modelStatus: this.aiModelService.status.value,
        onReloadModels: this.aiModelService.reload,
        reasoning: this.extendedThinking,
        reasoningAvailable: this.aiModelService.reasoningAvailable,
        searchWorkspace: !!config.searchWorkspace && !!config.readingDocs,
        disabled: this.disabled,
        onModelChange: this.aiModelService.setModel,
        onReasoningChange: (enabled) =>
          this.onExtendedThinkingChange?.(enabled),
        onSearchChange: (enabled) =>
          this.toolsConfigService.setConfig({
            searchWorkspace: enabled,
            readingDocs: enabled,
          }),
      }),
      true,
    );
  }
}
