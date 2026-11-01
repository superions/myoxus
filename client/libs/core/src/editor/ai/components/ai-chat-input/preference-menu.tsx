// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AIModel } from "@myoxus/core/modules/ai-button/services/models";
import { useI18n } from "@myoxus/i18n";
import { SettingsIcon } from "@myoxus/icons/react";
import {
  Checkbox,
  Button,
  MyoxusText,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import { useState } from "react";

export interface ChatPreferenceMenuProps {
  models: AIModel[];
  modelId?: string;
  modelStatus: "loading" | "ready" | "empty" | "error";
  onReloadModels: () => Promise<void>;
  reasoning: boolean;
  reasoningAvailable?: boolean;
  searchWorkspace: boolean;
  disabled: boolean;
  onModelChange: (id: string) => void;
  onReasoningChange: (enabled: boolean) => void;
  onSearchChange: (enabled: boolean) => void;
}

/** Native preference controls project existing services, not view-owned copies. */
export function ChatPreferenceMenu(props: ChatPreferenceMenuProps) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      position="bottom-start"
      contentMeasure="reading"
      fitViewport
      trapFocus
      returnFocus
      closeOnEscape
    >
      <PopoverTarget>
        <IconButton
          size="small"
          data-testid="chat-input-preference-trigger"
          aria-label={t["com.myoxus.ai.chat-panel.model"]()}
          tooltip={t["com.myoxus.ai.chat-panel.model"]()}
          tooltipOptions={{ opened: open ? false : undefined }}
          disabled={props.disabled}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <SettingsIcon />
        </IconButton>
      </PopoverTarget>
      <PopoverContent
        role="dialog"
        aria-label={t["com.myoxus.ai.chat-panel.model"]()}
      >
        <Stack data-testid="chat-input-preference">
          {props.modelStatus === "loading" ? (
            <MyoxusText role="status">{t["Loading"]()}</MyoxusText>
          ) : null}
          {props.modelStatus === "empty" ? (
            <MyoxusText role="status">
              {t["com.myoxus.ai.models.empty"]()}
            </MyoxusText>
          ) : null}
          {props.modelStatus === "error" ? (
            <MyoxusText role="alert">
              {t["com.myoxus.ai.models.load-error"]()}
            </MyoxusText>
          ) : null}
          {props.modelStatus === "empty" || props.modelStatus === "error" ? (
            <Button onClick={() => void props.onReloadModels()}>
              {t["Retry"]()}
            </Button>
          ) : null}
          <Select
            label={t["com.myoxus.ai.chat-panel.model"]()}
            value={props.modelId ?? null}
            data={props.models.map((model) => ({
              value: model.id,
              label: model.name,
            }))}
            disabled={
              props.disabled ||
              props.modelStatus !== "ready" ||
              !props.models.length
            }
            onChange={(id) => {
              if (id) props.onModelChange(id);
            }}
          />
          {props.modelStatus === "ready" &&
          props.modelId &&
          !props.models.some((model) => model.id === props.modelId) ? (
            <MyoxusText role="alert">
              {t["com.myoxus.ai.models.selection-unavailable"]()}
            </MyoxusText>
          ) : null}
          <Checkbox
            label={t["com.myoxus.ai.chat-panel.reasoning"]()}
            checked={props.reasoning}
            disabled={props.disabled || !props.reasoningAvailable}
            onChange={(event) =>
              props.onReasoningChange(event.currentTarget.checked)
            }
          />
          <Checkbox
            label={t["com.myoxus.ai.chat-panel.search-workspace"]()}
            checked={props.searchWorkspace}
            disabled={props.disabled}
            onChange={(event) =>
              props.onSearchChange(event.currentTarget.checked)
            }
          />
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
