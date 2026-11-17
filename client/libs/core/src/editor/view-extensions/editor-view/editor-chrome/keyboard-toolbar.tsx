// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { ArrowLeftBigIcon, KeyboardIcon } from "@myoxus/icons/react";
import { toReactNode } from "@myoxus/lit-react";
import {
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
  EditorKeyboardPanelControls,
  EditorKeyboardToolbarControls,
} from "@virgultum/editor/shared/services";

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
                icon={toReactNode(action.icon)}
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
                      icon={toReactNode(action.icon)}
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
