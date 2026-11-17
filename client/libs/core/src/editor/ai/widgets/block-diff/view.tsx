// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  CloseIcon,
  DoneIcon,
  CodeIcon,
} from "@myoxus/icons/react";
import {
  Button,
  Group,
  IconButton,
  Stack,
  Textarea,
  MyoxusText,
  ToolbarSurface,
  Card,
} from "@myoxus/ui-facade";

export function DiffOptions({
  accept,
  reject,
}: {
  accept: () => void;
  reject: () => void;
}) {
  const t = useI18n();
  return (
    <Stack gap="xs">
      <IconButton
        tooltip={t["com.myoxus.editor.diff.accept"]()}
        onClick={accept}
      >
        <DoneIcon />
      </IconButton>
      <IconButton
        tooltip={t["com.myoxus.editor.diff.reject"]()}
        onClick={reject}
      >
        <CloseIcon />
      </IconButton>
    </Stack>
  );
}

export function DiffToolbar({
  current,
  total,
  previous,
  next,
  accept,
  reject,
}: {
  current: number;
  total: number;
  previous: () => void;
  next: () => void;
  accept: () => void;
  reject: () => void;
}) {
  const t = useI18n();
  return (
    <ToolbarSurface
      compact
      role="toolbar"
      aria-label={t["com.myoxus.editor.diff.title"]()}
    >
      <IconButton
        tooltip={t["common.next"]()}
        disabled={current >= total}
        onClick={next}
      >
        <ArrowDownSmallIcon />
      </IconButton>
      <MyoxusText>
        {new Intl.NumberFormat(t.language).format(current)} /{" "}
        {new Intl.NumberFormat(t.language).format(total)}
      </MyoxusText>
      <IconButton
        tooltip={t["common.previous"]()}
        disabled={current <= 1}
        onClick={previous}
      >
        <ArrowUpSmallIcon />
      </IconButton>
      <Button prefix={<CloseIcon />} onClick={reject}>
        {t["com.myoxus.editor.diff.reject-all"]()}
      </Button>
      <Button prefix={<DoneIcon />} onClick={accept}>
        {t["com.myoxus.editor.diff.accept-all"]()}
      </Button>
    </ToolbarSurface>
  );
}

export function DiffPlaygroundButton({ open }: { open: () => void }) {
  const t = useI18n();
  return (
    <IconButton
      size={56}
      variant="primary"
      data-testid="block-diff-playground"
      tooltip={t["com.myoxus.editor.diff.title"]()}
      onClick={open}
    >
      <CodeIcon />
    </IconButton>
  );
}

export function DiffPlaygroundForm({
  markdown,
  input,
  load,
  clear,
  confirm,
}: {
  markdown: string;
  input: (value: string) => void;
  load: () => void;
  clear: () => void;
  confirm: () => void;
}) {
  const t = useI18n();
  return (
    <Card withBorder padding="md">
      <Stack
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <MyoxusText>{t["com.myoxus.editor.diff.title"]()}</MyoxusText>
        <Textarea
          autoFocus
          autosize
          minRows={6}
          maxRows={14}
          aria-label={t["com.myoxus.editor.diff.markdown"]()}
          placeholder={t["com.myoxus.editor.diff.markdown"]()}
          value={markdown}
          onChange={input}
        />
        <Group justify="flex-end">
          <Button onClick={load}>
            {t["com.myoxus.editor.diff.current-document"]()}
          </Button>
          <Button onClick={clear}>
            {t["com.myoxus.editor.field.clear"]()}
          </Button>
          <Button variant="primary" onClick={confirm}>
            {t["Confirm"]()}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
