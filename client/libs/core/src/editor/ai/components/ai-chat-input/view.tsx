// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { ArrowUpBigIcon, CloseIcon, StopIcon } from "@myoxus/icons/react";
import {
  Alert,
  Blockquote,
  Group,
  IconButton,
  MyoxusText,
  notify,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import type { Signal } from "@preact/signals-core";
import type {
  ClipboardEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useSyncExternalStore } from "react";

export interface ChatInputViewProps {
  draft: Signal<string>;
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
    event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  onStop: () => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveQuote: () => void;
}

/** The Lit input owns the draft signal; this view adds no draft/session store. */
export function ChatInputView(props: ChatInputViewProps) {
  const t = useI18n();
  const subscribe = useCallback(
    (notify: () => void) => props.draft.subscribe(notify),
    [props.draft],
  );
  // Restoration can finish between portal render and subscription. Read the
  // current snapshot at subscription too, rather than missing that draft update.
  const value = useSyncExternalStore(subscribe, () => props.draft.value);
  const actionLabel = props.generating
    ? t["com.myoxus.ai.chat-panel.stop"]()
    : t["com.myoxus.ai.chat-panel.send"]();
  const retrievalMessage =
    t["com.myoxus.ai.chat-panel.workspace-search-unavailable"]();
  useEffect(() => {
    // Polling may rerender an unavailable index. Notify on the transition only,
    // so dismissing the native notification keeps the composer clear.
    if (props.retrievalUnavailable) notify.warning({ title: retrievalMessage });
  }, [props.retrievalUnavailable, retrievalMessage]);
  return (
    <Stack data-myoxus-ui-role="chat-composer-input">
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
        autosize
        minRows={2}
        maxRows={8}
        value={value}
        placeholder={t["com.myoxus.ai.chat-panel.input-placeholder"]()}
        aria-label={t["com.myoxus.ai.chat-panel.input-placeholder"]()}
        data-testid="chat-panel-input"
        onChange={props.onInput}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          )
            props.onSend(event);
        }}
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
