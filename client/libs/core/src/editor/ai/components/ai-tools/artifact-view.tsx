// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  CopyIcon,
  DoneIcon,
  DownloadIcon,
  PageIcon,
} from "@myoxus/icons/react";
import {
  Button,
  CopyButton,
  Group,
  IconButton,
  MyoxusLoader,
  MyoxusSegmentedControl,
  ReferenceCard,
  Scrollable,
} from "@myoxus/ui-facade";
import { type ReactNode, useEffect, useRef, useState } from "react";

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

function TimedCopyActionButton({
  onCopy,
}: {
  onCopy: () => boolean | void | Promise<boolean | void>;
}) {
  const t = useI18n();
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const label = copied ? t["Copied to clipboard"]() : t["Copy"]();
  return (
    <IconButton
      aria-label={label}
      tooltip={label}
      onClick={() => {
        void Promise.resolve(onCopy()).then((result) => {
          if (!mountedRef.current || result === false) return;
          if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
          setCopied(true);
          resetTimerRef.current = setTimeout(() => {
            if (!mountedRef.current) return;
            setCopied(false);
            resetTimerRef.current = null;
          }, 2000);
        });
      }}
    >
      {copied ? <DoneIcon /> : <CopyIcon />}
    </IconButton>
  );
}

export function DocComposeControls({
  copy,
  copyText,
  onCopied,
  save,
}: {
  copy?: () => boolean | void | Promise<boolean | void>;
  copyText?: string;
  onCopied?: () => void;
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
      {copyText !== undefined ? (
        <CopyButton value={copyText} timeout={2000}>
          {({ copied, copy: triggerCopy }) => {
            const label = copied ? t["Copied to clipboard"]() : t["Copy"]();
            return (
              <IconButton
                aria-label={label}
                tooltip={label}
                onClick={() => {
                  triggerCopy();
                  onCopied?.();
                }}
              >
                {copied ? <DoneIcon /> : <CopyIcon />}
              </IconButton>
            );
          }}
        </CopyButton>
      ) : copy ? (
        <TimedCopyActionButton onCopy={copy} />
      ) : null}
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
  copy: () => boolean | void | Promise<boolean | void>;
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
      <TimedCopyActionButton onCopy={copy} />
    </>
  );
}
