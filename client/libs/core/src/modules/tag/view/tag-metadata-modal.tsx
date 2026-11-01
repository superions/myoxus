// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { TagColor, TagLike } from "@myoxus/core/components/tags/types";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  ColorSwatch,
  DialogFooter,
  DialogFooterActions,
  Input,
  Menu,
  MenuItem,
  Modal,
  MyoxusText,
  Notice,
  Stack,
  Textarea,
  type TagColorRole,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

export type TagMetadata = {
  name: string;
  color: TagColorRole;
  description: string;
};

export function normalizeTagMetadata(metadata: TagMetadata): TagMetadata {
  return {
    ...metadata,
    name: metadata.name.trim(),
    description: metadata.description.trim(),
  };
}

export function TagMetadataModal({
  colors,
  mode,
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  tag,
}: {
  colors: readonly TagColor[];
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSubmit: (metadata: TagMetadata) => Promise<boolean>;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  tag?: TagLike;
}) {
  const t = useI18n();
  const initialMetadata = useMemo<TagMetadata>(
    () => ({
      name: tag?.name ?? "",
      color: tag?.color ?? colors[0]?.value ?? "tag.grey",
      description: tag?.description ?? "",
    }),
    [colors, tag],
  );
  const [draft, setDraft] = useState(initialMetadata);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const initialMetadataRef = useRef(initialMetadata);
  initialMetadataRef.current = initialMetadata;
  const openSourceKey = open ? (tag?.id ?? "create") : null;

  useEffect(() => {
    if (openSourceKey !== null) {
      setDraft(initialMetadataRef.current);
      setFailed(false);
    }
  }, [openSourceKey]);

  const selectedColor =
    colors.find((color) => color.value === draft.color) ?? colors[0];
  const normalized = normalizeTagMetadata(draft);
  const submit = useCallback(async () => {
    if (!normalized.name || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const acknowledged = await onSubmit(normalized);
      if (acknowledged) {
        onOpenChange(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }, [normalized, onOpenChange, onSubmit, saving]);

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen);
      }}
      title={
        mode === "create"
          ? t["com.myoxus.tags.metadata.create-title"]()
          : t["com.myoxus.tags.metadata.edit-title"]()
      }
      contentOptions={{ "data-testid": "tag-metadata-modal" }}
      returnFocusRef={returnFocusRef}
    >
      <Stack>
        {failed ? (
          <Notice
            title={t["com.myoxus.common.operation-failed"]()}
            tone="error"
          />
        ) : null}
        <Input
          autoFocus
          error={
            draft.name.length > 0 && !normalized.name
              ? t["com.myoxus.tags.metadata.name-required"]()
              : undefined
          }
          label={t["com.myoxus.tags.name"]()}
          onChange={(name) => setDraft({ ...draft, name })}
          onEnter={() => void submit()}
          placeholder={t["com.myoxus.tags.create-tag.placeholder"]()}
          value={draft.name}
        />
        <Textarea
          autosize
          label={t["com.myoxus.tags.metadata.description"]()}
          minRows={4}
          onChange={(description) => setDraft({ ...draft, description })}
          placeholder={t["com.myoxus.tags.metadata.description-placeholder"]()}
          value={draft.description}
        />
        <Stack gap="xs">
          <MyoxusText typographySlot="label-compact">
            {t["Colors"]()}
          </MyoxusText>
          <Menu
            items={colors.map((color) => (
              <MenuItem
                checked={color.value === draft.color}
                key={color.id}
                onClick={() => setDraft({ ...draft, color: color.value })}
                prefixIcon={
                  <ColorSwatch tagColorRole={color.value} shape="circle" />
                }
              >
                {color.name}
              </MenuItem>
            ))}
          >
            <Button
              prefix={
                <ColorSwatch
                  tagColorRole={selectedColor?.value ?? draft.color}
                  shape="circle"
                />
              }
              variant="secondary"
            >
              {selectedColor?.name ?? t["Colors"]()}
            </Button>
          </Menu>
        </Stack>
        <DialogFooter>
          <DialogFooterActions>
            <Button
              disabled={saving}
              onClick={() => onOpenChange(false)}
              variant="secondary"
            >
              {t["Cancel"]()}
            </Button>
            <Button
              disabled={!normalized.name}
              loading={saving}
              onClick={() => void submit()}
              variant="primary"
            >
              {mode === "create" ? t["Create"]() : t["Save"]()}
            </Button>
          </DialogFooterActions>
        </DialogFooter>
      </Stack>
    </Modal>
  );
}
