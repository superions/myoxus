// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  AiIcon,
  ArrowUpBigIcon,
  StopIcon,
  CopyIcon,
  DoneIcon,
  ArrowRightSmallIcon,
} from "@myoxus/icons/react";
import {
  Box,
  Stack,
  Group,
  Card,
  Textarea,
  IconButton,
  Button,
  MyoxusText,
  MyoxusLoader,
  MenuItem,
  Menu,
  MenuTrigger,
  MenuSectionLabel,
  Divider,
  Tooltip,
  Scrollable,
  MenuPanel,
  type MenuPanelProps,
} from "@myoxus/ui-facade";
import { editorGlyph } from "../../../view-extensions/editor-view/editor-chrome/glyphs";
import { NotificationProvider } from "@virgultum/editor/shared/services";
import type { EditorHost } from "@virgultum/editor/std";
import {
  useState,
  useEffect,
  useRef,
  Fragment,
  isValidElement,
  type ComponentProps,
} from "react";
import type { AIItemGroupConfig } from "../../components/ai-item/types";
import { AIErrorType } from "../../provider";
import type { MyoxusAIPanelWidgetConfig, MyoxusAIPanelState } from "./type";
import { filterAIItemGroup } from "./utils";

type ActionProps = {
  host: EditorHost;
  groups: AIItemGroupConfig[];
  onChoose?: () => void;
  compact?: boolean;
};

/** Present existing producers; commands, availability and selection stay with their owners. */
export function AIActionGroups({
  host,
  groups,
  onChoose,
  compact = false,
}: ActionProps) {
  const renderItems = (group: AIItemGroupConfig) =>
    group.items.map((item) => {
      const icon =
        editorGlyph(
          item.iconName ??
            (typeof item.icon === "string"
              ? (item.icon as Parameters<typeof editorGlyph>[0])
              : undefined),
        ) ?? (typeof item.icon !== "string" ? item.icon : null);
      const label = item.beta ? `${item.name} (Beta)` : item.name;
      const choose = () => {
        onChoose?.();
        item.handler?.(host);
      };
      if (item.subItem?.length)
        return (
          <Menu
            key={item.testId}
            rootOptions={{ modal: false }}
            contentOptions={{
              side: "right",
              align: "start",
              onPointerDown: (event) => event.stopPropagation(),
              onWheel: (event) => event.stopPropagation(),
            }}
            items={item.subItem.map((sub) => (
              <MenuItem
                key={sub.testId ?? sub.type}
                data-testid={sub.testId}
                onSelect={() => {
                  onChoose?.();
                  sub.handler?.(host);
                }}
              >
                {sub.type}
              </MenuItem>
            ))}
          >
            {compact ? (
              <MenuTrigger
                prefix={
                  isValidElement<ComponentProps<"svg">>(icon) ? icon : undefined
                }
                tooltip={label}
                aria-label={label}
                data-testid={item.testId}
              />
            ) : (
              <MenuItem
                closeMenuOnClick={false}
                prefixIcon={icon}
                suffixIcon={<ArrowRightSmallIcon />}
                data-testid={item.testId}
              >
                {label}
              </MenuItem>
            )}
          </Menu>
        );
      return compact ? (
        <IconButton
          key={item.testId}
          icon={icon}
          tooltip={label}
          aria-label={label}
          data-testid={item.testId}
          onClick={choose}
        />
      ) : (
        <MenuItem
          key={item.testId}
          prefixIcon={icon}
          data-testid={item.testId}
          onSelect={choose}
        >
          {label}
        </MenuItem>
      );
    });
  return compact ? (
    <Group gap="xs">
      {groups.map((group, index) => (
        <Fragment key={group.testId ?? index}>
          {index ? <Divider orientation="vertical" /> : null}
          <Group
            gap="xs"
            role="group"
            aria-label={group.name}
            data-testid={group.testId}
          >
            {renderItems(group)}
          </Group>
        </Fragment>
      ))}
    </Group>
  ) : (
    <>
      {groups.map((group, index) => (
        <Box key={group.testId ?? index} data-testid={group.testId}>
          {index ? <Divider /> : null}
          {group.name ? (
            <MenuSectionLabel>{group.name}</MenuSectionLabel>
          ) : null}
          {renderItems(group)}
        </Box>
      ))}
    </>
  );
}

/** One bounded menu for inline/audio and canvas producers, without another catalogue. */
export function AIActionMenu({
  host,
  groups,
  onChoose,
  panelWidth,
  maxHeight = "popover",
}: ActionProps & {
  panelWidth?: MenuPanelProps["panelWidth"];
  maxHeight?: "floating" | "popover";
}) {
  return (
    <Card withBorder>
      <MenuPanel panelWidth={panelWidth}>
        <Scrollable.Viewport autosize maxHeight={maxHeight} scrollbars="y">
          <AIActionGroups host={host} groups={groups} onChoose={onChoose} />
        </Scrollable.Viewport>
      </MenuPanel>
    </Card>
  );
}

export function AIPanelView({
  state,
  config,
  host,
  answer,
  progress,
  answerContextVersion = 0,
  onInput,
  onFinish,
  onStop,
  setInput,
}: {
  state: MyoxusAIPanelState;
  config: MyoxusAIPanelWidgetConfig;
  host: EditorHost;
  answer: string | null;
  progress: number;
  answerContextVersion?: number;
  onInput: (text: string) => void;
  onFinish: (text: string) => void;
  onStop: () => void;
  setInput: (element: HTMLTextAreaElement | null) => void;
}) {
  void answerContextVersion;
  const t = useI18n();
  const [input, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (state === "input") setValue("");
    if (state === "generating") {
      setCopied(false);
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
        copyResetRef.current = null;
      }
    }
  }, [state]);
  useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    },
    [],
  );
  const renderedAnswer =
    answer !== null ? config.answerRenderer(answer, state) : null;
  const send = () => {
    const value = input.trim();
    if (value) onFinish(value);
  };
  const generating = state === "generating",
    failed = state === "error";
  const responseGroups = filterAIItemGroup(
    host,
    config[failed ? "errorStateConfig" : "finishStateConfig"].responses,
  );
  const canRespond =
    !failed ||
    !config.errorStateConfig.error?.type ||
    config.errorStateConfig.error.type === AIErrorType.GeneralNetworkError;
  const actions = [
    ...(!generating && canRespond ? responseGroups : []),
    ...(state === "finished" ? config.finishStateConfig.actions : []),
  ];
  const stages = config.generatingStateConfig.stages ?? [];
  const stage = Math.max(1, Math.min(progress, stages.length || 1));
  return (
    <Card
      withBorder
      padding="sm"
      maxHeight="var(--myoxus-popover-available-height)"
      data-testid="ai-panel-container"
    >
      <Stack gap="xs" mih={0}>
        {state === "input" ? (
          <Group wrap="nowrap" align="center">
            <AiIcon />
            <Textarea
              variant="unstyled"
              ref={setInput}
              autoFocus
              autosize
              minRows={1}
              maxRows={6}
              flex={1}
              aria-label={t["com.myoxus.ai.chat-panel.input-placeholder"]()}
              placeholder={t["com.myoxus.ai.chat-panel.input-placeholder"]()}
              value={input}
              onChange={(value) => {
                setValue(value);
                onInput(value);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <IconButton
              variant="primary"
              aria-label={t["com.myoxus.ai.chat-panel.send"]()}
              tooltip={t["com.myoxus.ai.chat-panel.send"]()}
              data-testid="ai-panel-input-send"
              disabled={!input.trim()}
              onClick={send}
            >
              <ArrowUpBigIcon />
            </IconButton>
          </Group>
        ) : (
          <>
            <Scrollable.Viewport
              autosize
              fill
              maxHeight="floating"
              scrollbars="y"
            >
              <Stack gap="xs">
                {answer !== null ? (
                  <Box data-testid="answer-content">{renderedAnswer}</Box>
                ) : null}
                {generating ? (
                  <Group
                    wrap="nowrap"
                    data-testid="ai-generating"
                    mih={
                      stages.length > 0 &&
                      Number.isFinite(config.generatingStateConfig.height)
                        ? config.generatingStateConfig.height
                        : undefined
                    }
                  >
                    {editorGlyph(
                      config.generatingStateConfig.generatingIcon,
                    ) || <MyoxusLoader />}
                    <Stack gap={0} flex={1}>
                      <MyoxusText>
                        {t["com.myoxus.ai.chat-panel.generating"]()}
                      </MyoxusText>
                      {stages.length ? (
                        <MyoxusText typographySlot="caption" tone="secondary">
                          {stages[stage - 1]} · {stage} / {stages.length}
                        </MyoxusText>
                      ) : null}
                    </Stack>
                    <IconButton
                      data-testid="ai-stop"
                      aria-label={t["com.myoxus.ai.chat-panel.stop"]()}
                      tooltip={t["com.myoxus.ai.chat-panel.stop"]()}
                      onClick={onStop}
                    >
                      <StopIcon />
                    </IconButton>
                  </Group>
                ) : null}
                {failed ? (
                  <Stack gap="xs" role="alert" data-testid="ai-error">
                    <Tooltip content={config.errorStateConfig.error?.message}>
                      <MyoxusText>
                        {config.errorStateConfig.error?.type ===
                        AIErrorType.Unauthorized
                          ? t["com.myoxus.ai.chat-panel.login-required"]()
                          : t["com.myoxus.ai.chat-panel.error"]()}
                      </MyoxusText>
                    </Tooltip>
                    {config.errorStateConfig.error?.type ===
                    AIErrorType.Unauthorized ? (
                      <Group>
                        <Button onClick={config.errorStateConfig.cancel}>
                          {t["Cancel"]()}
                        </Button>
                        <Button onClick={config.errorStateConfig.login}>
                          {t["Sign in"]()}
                        </Button>
                      </Group>
                    ) : null}
                  </Stack>
                ) : null}
              </Stack>
            </Scrollable.Viewport>
            {!generating && (!failed || answer !== null) ? (
              <Group wrap="nowrap">
                <MyoxusText typographySlot="caption" tone="secondary" flex={1}>
                  {t["com.myoxus.ai.chat-panel.disclaimer"]()}
                </MyoxusText>
                {config.copy?.allowed ? (
                  <IconButton
                    data-testid={
                      copied ? "answer-copied" : "answer-copy-button"
                    }
                    aria-label={
                      copied ? t["Copied to clipboard"]() : t["Copy"]()
                    }
                    tooltip={copied ? t["Copied to clipboard"]() : t["Copy"]()}
                    onClick={async () => {
                      const ok = !!(await config.copy?.onCopy());
                      if (copyResetRef.current) {
                        clearTimeout(copyResetRef.current);
                        copyResetRef.current = null;
                      }
                      setCopied(ok);
                      if (ok) {
                        copyResetRef.current = setTimeout(() => {
                          setCopied(false);
                          copyResetRef.current = null;
                        }, 2000);
                        host.std
                          .getOptional(NotificationProvider)
                          ?.toast(t["Copied to clipboard"]());
                      }
                    }}
                  >
                    {copied ? <DoneIcon /> : <CopyIcon />}
                  </IconButton>
                ) : null}
              </Group>
            ) : null}
            {actions.length ? (
              <>
                <Divider />
                <AIActionGroups host={host} groups={actions} compact />
              </>
            ) : null}
          </>
        )}
      </Stack>
    </Card>
  );
}
