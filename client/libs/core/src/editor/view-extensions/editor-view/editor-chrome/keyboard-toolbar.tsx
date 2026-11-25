// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useEffect, useRef } from "react";
import { useI18n } from "@myoxus/i18n";
import { ArrowLeftBigIcon, KeyboardIcon } from "@myoxus/icons/react";
import {
  Box,
  Card,
  Divider,
  Group,
  IconButton,
  Scrollable,
  SimpleGrid,
  Stack,
  Text,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type {
  EditorKeyboardIcon,
  EditorKeyboardPanelControls,
  EditorKeyboardToolbarControls,
} from "@virgultum/editor/shared/services";
import { editorGlyph } from "./glyphs";

function SvgMarkupIcon({ markup }: { markup: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = markup;
    return () => {
      el.replaceChildren();
    };
  }, [markup]);
  return <Box component="span" ref={ref} style={{ display: "contents" }} />;
}

function renderKeyboardIcon(icon: EditorKeyboardIcon) {
  return typeof icon === "string" ? (
    editorGlyph(icon)
  ) : (
    <SvgMarkupIcon markup={icon.svg} />
  );
}

export function EditorKeyboardToolbar({
  controls,
}: {
  controls: EditorKeyboardToolbarControls;
}) {
  const t = useI18n();
  return (
    <ToolbarSurface>
      <Scrollable.Root flex={1}>
        <Scrollable.Viewport autosize scrollbars="x">
          <Group wrap="nowrap">
            {controls.back ? (
              <IconButton
                icon={<ArrowLeftBigIcon />}
                tooltip={t["com.myoxus.backButton"]()}
                onClick={controls.back}
              />
            ) : null}
            {controls.actions.map((action) => (
              <IconButton
                key={action.id}
                icon={renderKeyboardIcon(action.icon)}
                tooltip={action.label}
                aria-pressed={action.active}
                variant={action.active ? "secondary" : "plain"}
                disabled={action.disabled}
                onClick={action.run}
              />
            ))}
          </Group>
        </Scrollable.Viewport>
      </Scrollable.Root>
      <Divider orientation="vertical" />
      <IconButton
        icon={<KeyboardIcon />}
        tooltip={t["com.myoxus.editor.keyboard.toggle"]()}
        aria-pressed={controls.keyboardVisible}
        onClick={controls.toggleKeyboard}
      />
    </ToolbarSurface>
  );
}

export function EditorKeyboardPanel({
  controls,
}: {
  controls: EditorKeyboardPanelControls;
}) {
  return (
    <Card withBorder fullHeight padding="sm">
      <Scrollable.Viewport scrollbars="y">
        <Stack>
          {controls.groups.map((group, index) => (
            <Stack key={index}>
              <Text size="sm" c="dimmed">
                {group.label}
              </Text>
              <SimpleGrid cols={4}>
                {group.actions.map((action) => (
                  <Stack key={action.id} align="center" gap="xs">
                    <IconButton
                      icon={renderKeyboardIcon(action.icon)}
                      tooltip={action.label}
                      disabled={action.disabled}
                      onClick={action.run}
                    />
                    <Text size="sm" truncate>
                      {action.label}
                    </Text>
                  </Stack>
                ))}
              </SimpleGrid>
            </Stack>
          ))}
        </Stack>
      </Scrollable.Viewport>
    </Card>
  );
}
