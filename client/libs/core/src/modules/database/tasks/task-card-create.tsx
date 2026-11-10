// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import {
  Box,
  Button,
  Group,
  Input,
  Loading,
  MyoxusText,
  Notice,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useRef, useState } from "react";
import { useCaptureTask } from "./use-capture-task";
import { useTaskDestinations, useTaskIdentity } from "./use-workspace-tasks";

type Props = DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["task-card-create"]>;

export function TaskCardCreate(props: Props) {
  const owner = useTaskIdentity();
  const valid =
    owner.identity === props.openingOwnerIdentity && props.isCurrent();
  useEffect(() => {
    if (!valid) props.close();
  }, [valid, props.close]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (!props.isCurrent()) props.close();
    });
    observer.observe(props.anchor.ownerDocument, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [props.anchor, props.isCurrent, props.close]);
  return valid && owner.server && owner.identity ? (
    <Creation
      key={owner.identity}
      {...props}
      server={owner.server}
      identity={owner.identity}
      workspaceId={owner.workspace.id}
    />
  ) : null;
}

function Creation({
  server,
  identity,
  workspaceId,
  ...props
}: Props & {
  server: NonNullable<ReturnType<typeof useTaskIdentity>["server"]>;
  identity: string;
  workspaceId: string;
}) {
  const t = useI18n();
  const destinations = useTaskDestinations();
  const destination = destinations.defaultDestination;
  const destinationReady = Boolean(
    destination &&
    destinations.readyDestinations.some(
      (item) => item.id === destination.databaseId,
    ),
  );
  const creator = useCaptureTask(
    server,
    workspaceId,
    identity,
    props.source.sourceDocumentId,
    "",
  );
  const [title, setTitle] = useState(creator.retained?.input.title ?? "");
  const [insertionFailed, setInsertionFailed] = useState(false);
  const [insertionPending, setInsertionPending] = useState(false);
  const inserting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const close = () => {
    if (inserting.current) return;
    // Only confirmed insertion releases capture; a failed insertion stays recoverable.
    if (creator.phase === "confirmed") creator.retainForReferenceRecovery();
    props.close();
    if (props.anchor.isConnected)
      props.anchor
        .querySelector<HTMLElement>('[contenteditable="true"]')
        ?.focus();
  };
  const insert = async () => {
    const result = creator.result;
    const input = creator.retained?.input;
    if (!result || !input || inserting.current || !props.isCurrent()) return;
    inserting.current = true;
    setInsertionPending(true);
    setInsertionFailed(false);
    const state = await props.onInsertReference(
      result.requestId,
      {
        workspaceId,
        databaseId: result.databaseId,
        rowId: result.rowId,
      },
      {
        sourceDocumentId: input.sourceDocumentId,
        sourceExternalId: input.sourceExternalId,
        blockId: input.blockId ?? props.source.blockId,
        selectionAnchor: input.selectionAnchor,
      },
    );
    inserting.current = false;
    if (!alive.current) return;
    setInsertionPending(false);
    if (state === "inserted") {
      creator.release();
      props.onInserted(result.requestId);
      close();
    } else setInsertionFailed(true);
  };
  useEffect(() => {
    if (creator.result) void insert();
  }, [creator.result]);
  const submit = () => {
    if (
      !props.isCurrent() ||
      !destination ||
      !destinationReady ||
      !title.trim()
    )
      return;
    void creator.submit({
      databaseId: destination.databaseId,
      sourceDocumentId: props.source.sourceDocumentId,
      sourceExternalId: props.source.sourceExternalId,
      blockId: props.source.blockId,
      title: title.trim(),
      cells: [],
    });
  };
  const draft = creator.phase === "draft";
  return (
    <Popover
      opened
      position="bottom-start"
      floatingStrategy="fixed"
      fitViewport
      trapFocus
      returnFocus={false}
      onChange={(open) => {
        if (!open && creator.phase !== "pending") close();
      }}
      closeOnEscape={creator.phase !== "pending"}
      closeOnClickOutside={creator.phase !== "pending"}
    >
      <PopoverTarget>
        <span
          aria-hidden
          ref={(element) => {
            // A renderer-owned paragraph supplies anchor geometry; Mantine owns placement.
            if (element)
              element.getBoundingClientRect = () =>
                props.anchor.getBoundingClientRect();
          }}
        />
      </PopoverTarget>
      <PopoverContent
        role="dialog"
        aria-label={t["com.myoxus.database.tasks.new"]()}
        data-range-sync-exclude="true"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") event.stopPropagation();
          if (event.nativeEvent.isComposing && event.key === "Enter")
            event.preventDefault();
        }}
      >
        <Box
          component="form"
          onCopy={(event) => event.stopPropagation()}
          onCut={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            if (draft) submit();
          }}
        >
          <Stack>
            <MyoxusText>
              {t["com.myoxus.database.tasks.workspace-tasks"]()}
            </MyoxusText>
            <Input
              aria-label={t.Title()}
              placeholder={t["com.myoxus.database.tasks.new"]()}
              value={title}
              onChange={setTitle}
              autoFocus
              data-autofocus
              disabled={!draft}
            />
            {destinations.isLoading ? <Loading /> : null}
            {destinations.error ||
            (!destinations.isLoading && !destinationReady) ? (
              <Notice title={t["com.myoxus.database.embed.unavailable"]()}>
                <Button onClick={() => void destinations.mutate()}>
                  {t.Retry()}
                </Button>
              </Notice>
            ) : null}
            {creator.failure ? (
              <Notice tone="error">
                {t["com.myoxus.database.tasks.create-invalid"]()}
              </Notice>
            ) : null}
            {creator.phase === "uncertain" ? (
              <Notice
                tone="warning"
                title={t["com.myoxus.database.tasks.create-uncertain"]()}
              >
                <Group>
                  <Button
                    disabled={creator.checking}
                    onClick={() => void creator.review()}
                  >
                    {t["com.myoxus.database.tasks.check-created"]()}
                  </Button>
                  <Button
                    disabled={creator.checking}
                    variant="secondary"
                    onClick={() => void creator.replay()}
                  >
                    {t["com.myoxus.database.tasks.capture-replay"]()}
                  </Button>
                </Group>
                {creator.reviewFailed ? (
                  <MyoxusText>
                    {t["com.myoxus.database.row_detail.unavailable"]()}
                  </MyoxusText>
                ) : null}
              </Notice>
            ) : null}
            {insertionFailed ? (
              <Notice
                tone="warning"
                title={t["com.myoxus.database.tasks.reference-insert-failed"]()}
              >
                <Button onClick={() => void insert()}>
                  {t["com.myoxus.database.tasks.insert-reference"]()}
                </Button>
              </Notice>
            ) : null}
            <Group justify="flex-end">
              <Button
                variant="secondary"
                disabled={creator.phase === "pending" || insertionPending}
                onClick={close}
              >
                {creator.phase === "confirmed"
                  ? t["com.myoxus.peek-view-controls.close"]()
                  : t.Cancel()}
              </Button>
              {draft || creator.phase === "pending" ? (
                <Button
                  type="submit"
                  loading={creator.phase === "pending"}
                  disabled={
                    !draft ||
                    !title.trim() ||
                    !destinationReady ||
                    Boolean(destinations.error)
                  }
                >
                  {t.Create()}
                </Button>
              ) : null}
            </Group>
          </Stack>
        </Box>
      </PopoverContent>
    </Popover>
  );
}
