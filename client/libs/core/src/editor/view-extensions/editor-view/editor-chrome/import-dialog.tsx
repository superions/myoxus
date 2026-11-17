// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { ExportToHtmlIcon, ExportToMarkdownIcon } from "@myoxus/icons/react";
import {
  Button,
  Group,
  Modal,
  MyoxusLoader,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import type { EditorImportControls } from "@virgultum/editor/shared/services";
import { useSyncExternalStore } from "react";

export function EditorImportDialog({
  controls,
}: {
  controls: EditorImportControls;
}) {
  const { loading } = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
  );
  const t = useI18n();
  return (
    <Modal
      open
      title={t["Import"]()}
      persistent={loading}
      withoutCloseButton={loading}
      onOpenChange={(open) => {
        if (!open) controls.close();
      }}
    >
      <Stack>
        {loading ? (
          <Group wrap="nowrap" role="status">
            <MyoxusLoader />
            <Text>{t["com.myoxus.editor.import.progress-hint"]()}</Text>
          </Group>
        ) : (
          <>
            <Text>{t["com.myoxus.editor.import.supported-formats"]()}</Text>
            <Group>
              <Button
                prefix={<ExportToMarkdownIcon />}
                onClick={() => controls.choose("markdown")}
              >
                Markdown
              </Button>
              <Button
                prefix={<ExportToHtmlIcon />}
                onClick={() => controls.choose("html")}
              >
                HTML
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
