// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  PageIcon,
} from "@myoxus/icons/react";
import {
  Button,
  Group,
  IconButton,
  MyoxusLoader,
  MyoxusSegmentedControl,
  ReferenceCard,
  Scrollable,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function ArtifactCardView({
  title,
  icon,
  loading,
  open,
}: {
  title: string;
  icon: ReactNode;
  loading: boolean;
  open?: () => void;
}) {
  return (
    <ReferenceCard
      size="small"
      contained
      fullWidth
      component={open ? "button" : "div"}
      onClick={open}
      title={title}
      icon={icon}
      status={loading ? <MyoxusLoader /> : undefined}
      aria-busy={loading}
      data-testid="chat-artifact-card"
    />
  );
}

export function ArtifactPreviewView({
  title,
  icon,
  controls,
  children,
  close,
}: {
  title: string;
  icon: ReactNode;
  controls?: ReactNode;
  children?: ReactNode;
  close: () => void;
}) {
  const t = useI18n();
  return (
    <ReferenceCard
      size="preview"
      contained
      fullHeight
      title={title}
      icon={icon}
      actions={
        <IconButton
          aria-label={t["com.myoxus.peek-view-controls.close"]()}
          tooltip={t["com.myoxus.peek-view-controls.close"]()}
          onClick={close}
        >
          <CloseIcon />
        </IconButton>
      }
      data-testid="chat-artifact-preview"
    >
      {controls ? <Group>{controls}</Group> : null}
      <Scrollable.Root
        display="flex"
        flexDirection="column"
        flex={1}
        minHeight={0}
      >
        <Scrollable.Viewport fill>{children}</Scrollable.Viewport>
      </Scrollable.Root>
    </ReferenceCard>
  );
}

export function DocComposeControls({
  copy,
  save,
}: {
  copy: () => void;
  save?: () => void;
}) {
  const t = useI18n();
  return (
    <>
      {save && (
        <Button prefix={<PageIcon />} onClick={save}>
          {t["com.myoxus.ai.chat-panel.save-as-doc"]()}
        </Button>
      )}
      <IconButton aria-label={t["Copy"]()} tooltip={t["Copy"]()} onClick={copy}>
        <CopyIcon />
      </IconButton>
    </>
  );
}

export function CodeArtifactControls({
  mode,
  setMode,
  copy,
  download,
  insert,
}: {
  mode: "code" | "preview";
  setMode: (mode: "code" | "preview") => void;
  copy: () => void;
  download: () => void;
  insert?: () => void;
}) {
  const t = useI18n();
  return (
    <>
      <MyoxusSegmentedControl
        value={mode}
        layout="fluid"
        aria-label={t["com.myoxus.editor.toolbar.preview"]()}
        data={[
          { value: "code", label: t["com.myoxus.editor.keyboard.code"]() },
          { value: "preview", label: t["com.myoxus.editor.toolbar.preview"]() },
        ]}
        onChange={(value) => {
          if (value === "code" || value === "preview") setMode(value);
        }}
      />
      {insert ? (
        <Button prefix={<PageIcon />} onClick={insert}>
          {t["com.myoxus.common.insert"]()}
        </Button>
      ) : null}
      <IconButton
        aria-label={t["com.myoxus.attachment.download"]()}
        tooltip={t["com.myoxus.attachment.download"]()}
        onClick={download}
      >
        <DownloadIcon />
      </IconButton>
      <IconButton aria-label={t["Copy"]()} tooltip={t["Copy"]()} onClick={copy}>
        <CopyIcon />
      </IconButton>
    </>
  );
}
