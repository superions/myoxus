// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { ArrowUpBigIcon, CloseIcon, StopIcon } from "@myoxus/icons/react";
import {
  Alert,
  Blockquote,
  getHotkeyHandler,
  Group,
  IconButton,
  MyoxusText,
  notify,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import type {
  ClipboardEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import { useEffect, useMemo } from "react";

export interface ChatInputViewProps {
  value: string;
  quote?: string;
  images: ReactNode;
  context: ReactNode;
  preferences: ReactNode;
  generating: boolean;
  retrievalUnavailable?: boolean;
  imageInputUnsupported?: boolean;
  sendDisabled: boolean;
  onInput: (value: string) => void;
  onSend: (
    event:
      | MouseEvent<HTMLButtonElement>
      | KeyboardEvent<HTMLTextAreaElement>
      | globalThis.KeyboardEvent,
  ) => void;
  onStop: () => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveQuote: () => void;
}

/** Pure controlled React composer view backed by `@myoxus/ui-facade`. */
export function ChatInputView(props: ChatInputViewProps) {
  const t = useI18n();
  const handleKeyDown = useMemo(
    () =>
      getHotkeyHandler([
        [
          "Enter",
          (event) => {
            if (event.isComposing || event.keyCode === 229) return;
            props.onSend(event);
          },
        ],
      ]),
    [props.onSend],
  );
  const actionLabel = props.generating
    ? t["com.myoxus.ai.chat-panel.stop"]()
    : t["com.myoxus.ai.chat-panel.send"]();
  const retrievalMessage =
    t["com.myoxus.ai.chat-panel.workspace-search-unavailable"]();
  useEffect(() => {
    // Polling may rerender an unavailable index. Notify on the transition only,
    // so dismissing the native notification keeps the composer clear.
    if (props.retrievalUnavailable) {
      notify.warning(
        { title: retrievalMessage },
        { id: "chat-workspace-search-unavailable" },
      );
    }
  }, [props.retrievalUnavailable, retrievalMessage]);
  return (
    <Stack gap="xs" data-myoxus-ui-role="chat-composer-input">
      {props.images}
      {props.imageInputUnsupported ? (
        <Alert
          color="myoxusWarning"
          role="status"
          data-testid="chat-image-model-unsupported"
        >
          {t["com.myoxus.ai.chat-panel.image-model-unsupported"]()}
        </Alert>
      ) : null}
      {props.quote ? (
        <Blockquote data-testid="chat-selection-quote">
          <Group wrap="nowrap" justify="space-between">
            <MyoxusText>
              {props.quote.split("\n").slice(0, 2).join("\n")}
            </MyoxusText>
            <IconButton
              size="small"
              aria-label={t["Delete"]()}
              tooltip={t["Delete"]()}
              onClick={props.onRemoveQuote}
            >
              <CloseIcon />
            </IconButton>
          </Group>
        </Blockquote>
      ) : null}
      <Textarea
        variant="unstyled"
        autosize
        minRows={2}
        maxRows={8}
        value={props.value}
        placeholder={t["com.myoxus.ai.chat-panel.input-placeholder"]()}
        aria-label={t["com.myoxus.ai.chat-panel.input-placeholder"]()}
        data-testid="chat-panel-input"
        onChange={props.onInput}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onPaste={props.onPaste}
      />
      <Group justify="space-between" wrap="nowrap">
        {props.context}
        <Group wrap="nowrap">
          {props.preferences}
          <IconButton
            size="small"
            variant="primary"
            aria-label={actionLabel}
            tooltip={actionLabel}
            data-testid={
              props.generating ? "chat-panel-stop" : "chat-panel-send"
            }
            disabled={!props.generating && props.sendDisabled}
            onClick={props.generating ? props.onStop : props.onSend}
          >
            {props.generating ? <StopIcon /> : <ArrowUpBigIcon />}
          </IconButton>
        </Group>
      </Group>
    </Stack>
  );
}
