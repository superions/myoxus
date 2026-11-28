// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { IntegrationService } from "@myoxus/core/modules/integration";
import type { ReadwiseHighlight } from "@myoxus/core/modules/integration/type";
import { i18nTime, Trans, useI18n } from "@myoxus/i18n";
import { InformationFillDuotoneIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type ChangeEvent,
  type Dispatch,
  forwardRef,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso } from "react-virtuoso";

import {
  Badge,
  Button,
  Checkbox,
  DialogFooterActions,
  Loading,
  Modal,
  MyoxusText,
  notify,
  Progress,
  Scrollable,
  SettingsControlEmpty,
  SettingsPanelDescription,
  Stack,
  SurfaceListCell,
  SurfaceListHeaderCell,
  SurfaceListHeaderSelectionSlot,
  SurfaceListItem,
  SurfaceListSelectionSlot,
  SurfaceListTableHeader,
} from "../../../primitives";
import { readwiseTrack } from "./track";

// Keep the virtualized highlight viewport height bounded at the modal edge.
const DIALOG_HEIGHT = "min(65vh, calc(100dvh - var(--mantine-spacing-2xl)))";

const Scroller = forwardRef<HTMLDivElement>(function Scroller(props, ref) {
  return (
    <Scrollable.VirtualizedViewport
      ref={ref}
      data-myoxus-ui-role="readwise-import-highlight-scroll"
      {...props}
    />
  );
});

function HighlightTable({
  selected,
  setSelected,
  highlights,
}: {
  selected: ReadwiseHighlight["id"][];
  setSelected: Dispatch<SetStateAction<ReadwiseHighlight["id"][]>>;
  highlights: ReadwiseHighlight[];
}) {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const [updatedMap, setUpdatedMap] =
    useState<
      Record<ReadwiseHighlight["id"], ReadwiseHighlight["updated_at"]>
    >();

  const syncNewHighlights = useLiveData(
    useMemo(() => readwise.setting$("syncNewHighlights"), [readwise]),
  );
  const updateStrategy = useLiveData(
    useMemo(() => readwise.setting$("updateStrategy"), [readwise]),
  );

  useEffect(() => {
    readwise
      .getRefs()
      .then((refs) => {
        setUpdatedMap(
          Object.fromEntries(
            refs.map((ref) => [ref.refMeta.highlightId, ref.refMeta.updatedAt]),
          ),
        );
      })
      .catch(console.error);
  }, [readwise]);

  const allSelected = selected.length === highlights.length;

  const handleToggleAll = useCallback(
    (_: ChangeEvent, checked: boolean) => {
      readwiseTrack.selectIntegrationImport({
        method: "all",
        option: checked ? "on" : "off",
        control: "Readwise import list",
      });
      setSelected(checked ? highlights.map((item) => item.id) : []);
    },
    [highlights, setSelected],
  );

  return (
    <Stack
      flex={1}
      mih={0}
      data-myoxus-ui-role="readwise-import-highlight-table"
    >
      <SurfaceListTableHeader
        role="row"
        selectable="toggle"
        selectionActive={allSelected}
      >
        <SurfaceListHeaderSelectionSlot
          active={allSelected}
          selectable="toggle"
        >
          <Checkbox checked={allSelected} onChange={handleToggleAll} />
        </SurfaceListHeaderSelectionSlot>
        <SurfaceListHeaderCell flex={10}>
          {t["com.myoxus.integration.readwise.import.cell-h-content"]()}
        </SurfaceListHeaderCell>
        <SurfaceListHeaderCell flex={2}>
          {t["com.myoxus.integration.readwise.import.cell-h-todo"]()}
        </SurfaceListHeaderCell>
      </SurfaceListTableHeader>
      <Virtuoso
        style={{ height: "100%" }}
        totalCount={highlights.length}
        components={{ Scroller }}
        itemContent={(index) => {
          const highlight = highlights[index];
          const isChecked = selected.includes(highlight.id);
          const action = readwise.getAction({
            localUpdatedAt: updatedMap?.[highlight.id],
            remoteUpdatedAt: highlight.updated_at,
            updateStrategy,
            syncNewHighlights,
          });
          return (
            <SurfaceListItem
              component="div"
              role="row"
              layout="row"
              density="compact"
              fullWidth
              data-testid="readwise-highlight-row"
            >
              <SurfaceListSelectionSlot active={isChecked}>
                <Checkbox
                  checked={isChecked}
                  onChange={(_: ChangeEvent, checked: boolean) => {
                    readwiseTrack.selectIntegrationImport({
                      method: "single",
                      option: checked ? "on" : "off",
                      control: "Readwise import list",
                    });
                    setSelected((prev) =>
                      checked
                        ? [...prev, highlight.id]
                        : prev.filter((id) => id !== highlight.id),
                    );
                  }}
                />
              </SurfaceListSelectionSlot>
              <SurfaceListCell flex={10}>
                <Stack gap="xs">
                  <MyoxusText
                    component="a"
                    href={highlight.readwise_url}
                    target="_blank"
                    rel="noreferrer"
                    tone="link"
                    truncate
                    typographySlot="body-small"
                  >
                    {highlight.text}
                  </MyoxusText>
                  <MyoxusText
                    component="span"
                    tone="secondary"
                    truncate
                    typographySlot="body-small"
                  >
                    {i18nTime(highlight.updated_at, {
                      absolute: { accuracy: "second" },
                    })}
                  </MyoxusText>
                </Stack>
              </SurfaceListCell>
              <SurfaceListCell flex={2}>
                {action === "new" ? (
                  <Badge tone="success">
                    {t["com.myoxus.integration.readwise.import.todo-new"]()}
                  </Badge>
                ) : action === "skip" ? (
                  <Badge tone="neutral">
                    {t["com.myoxus.integration.readwise.import.todo-skip"]()}
                  </Badge>
                ) : (
                  <Badge tone="info">
                    {t["com.myoxus.integration.readwise.import.todo-update"]()}
                  </Badge>
                )}
              </SurfaceListCell>
            </SurfaceListItem>
          );
        }}
      />
    </Stack>
  );
}

function SelectStage({
  loading,
  highlights,
  onClose,
  onConfirm,
  onResetTimestamp,
}: {
  loading: boolean;
  highlights: ReadwiseHighlight[];
  onClose: () => void;
  onConfirm: (ids: ReadwiseHighlight["id"][]) => void;
  onResetTimestamp: () => void;
}) {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const lastImportedAt = useLiveData(readwise.settings$)?.lastImportedAt;
  const [selected, setSelected] = useState<ReadwiseHighlight["id"][]>([]);

  useEffect(() => {
    if (!loading) {
      setSelected(highlights.map((item) => item.id));
    }
  }, [highlights, loading]);

  const handleClearTimestamp = useCallback(() => {
    readwiseTrack.startIntegrationImport({
      method: "cleartimestamp",
      control: "Readwise import list",
    });
    readwise.updateSetting("lastImportedAt", undefined);
    onResetTimestamp();
  }, [onResetTimestamp, readwise]);

  return (
    <Stack h="100%" mih={0} data-myoxus-ui-role="readwise-import-select-stage">
      <SettingsPanelDescription>
        {lastImportedAt ? (
          <Trans
            i18nKey="com.myoxus.integration.readwise.import.desc-from-last"
            values={{
              lastImportedAt: i18nTime(lastImportedAt, {
                absolute: { accuracy: "second" },
              }),
            }}
            components={{
              a: (
                <MyoxusText
                  component="a"
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    handleClearTimestamp();
                  }}
                  tone="link"
                  typographySlot="body-small"
                />
              ),
            }}
          />
        ) : (
          t["com.myoxus.integration.readwise.import.desc-from-start"]()
        )}
      </SettingsPanelDescription>

      <Stack flex={1} mih={0}>
        {loading ? (
          <SettingsControlEmpty data-testid="readwise-import-loading">
            <Loading />
            {t["Loading"]()}
          </SettingsControlEmpty>
        ) : highlights.length > 0 ? (
          <HighlightTable
            selected={selected}
            setSelected={setSelected}
            highlights={highlights}
          />
        ) : (
          <SettingsControlEmpty data-testid="readwise-import-empty">
            {t["com.myoxus.integration.readwise.import.empty"]()}
          </SettingsControlEmpty>
        )}
      </Stack>

      <DialogFooterActions>
        <Button onClick={onClose}>{t["Cancel"]()}</Button>
        <Button
          disabled={
            loading || (selected.length === 0 && highlights.length !== 0)
          }
          variant="primary"
          onClick={() => onConfirm(selected)}
        >
          {t["Confirm"]()}
        </Button>
      </DialogFooterActions>
    </Stack>
  );
}

export const ImportDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const crawler = readwise.crawler;

  const crawlingData = useLiveData(crawler.data$);
  const error = useLiveData(crawler.error$);
  const loading = useLiveData(crawler.crawling$);

  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<"select" | "writing">("select");
  const abortRef = useRef<AbortController | null>(null);

  const highlights = useMemo(
    () => crawlingData?.highlights ?? [],
    [crawlingData],
  );
  const books = useMemo(() => crawlingData?.books ?? {}, [crawlingData]);
  const timestamp = crawlingData?.startTime;

  useEffect(() => {
    crawler.crawl();
    return () => {
      crawler.abort();
    };
  }, [crawler]);

  useEffect(
    () => () => {
      crawler.reset();
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [crawler],
  );

  const handleConfirm = useCallback(
    (ids: string[]) => {
      readwiseTrack.confirmIntegrationImport({
        control: "Readwise import list",
        method: readwise.setting$("lastImportedAt").value
          ? "withtimestamp"
          : "new",
      });
      if (ids.length === 0) {
        onClose();
        return;
      }

      setStage("writing");
      const chosen = highlights.filter((item) => ids.includes(item.id));
      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = Date.now();

      readwise
        .highlightsToMyoxusDocs(chosen.reverse(), books, {
          signal: controller.signal,
          onProgress: setProgress,
          onComplete: () => {
            readwiseTrack.completeIntegrationImport({
              total: chosen.length,
              done: chosen.length,
              time: (Date.now() - startedAt) / 1000,
            });
            readwise.updateSetting("lastImportedAt", timestamp);
            onClose();
          },
          onAbort: (finished) => {
            readwiseTrack.abortIntegrationImport({
              total: chosen.length,
              done: finished,
              time: (Date.now() - startedAt) / 1000,
            });
            notify({
              icon: <InformationFillDuotoneIcon />,
              style: "normal",
              alignMessage: "icon",
              title:
                t[
                  "com.myoxus.integration.readwise.import.abort-notify-title"
                ](),
              message: t.t(
                "com.myoxus.integration.readwise.import.abort-notify-desc",
                { finished },
              ),
            });
          },
        })
        .catch(console.error);
    },
    [books, highlights, onClose, readwise, t, timestamp],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStage("select");
    setProgress(0);
  }, []);

  const handleRetryCrawl = useCallback(() => {
    crawler.abort();
    crawler.crawl();
  }, [crawler]);

  const isWriting = stage === "writing";

  return (
    <Modal
      open
      width="lg"
      height={isWriting ? undefined : DIALOG_HEIGHT}
      title={
        isWriting
          ? t["com.myoxus.integration.readwise.import.importing"]()
          : t["com.myoxus.integration.readwise.import.title"]()
      }
      description={
        isWriting
          ? t["com.myoxus.integration.readwise.import.importing-desc"]()
          : undefined
      }
      contentOptions={{
        "data-testid": "readwise-import-dialog",
        style: { overflow: "hidden" },
      }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      withoutCloseButton={isWriting}
      persistent={isWriting}
    >
      {isWriting ? (
        <Stack data-myoxus-ui-role="readwise-import-writing-stage">
          <Progress
            value={progress}
            ariaLabel={t["com.myoxus.integration.readwise.import.importing"]()}
          />
          <DialogFooterActions>
            <Button variant="error" onClick={handleStop}>
              {t["com.myoxus.integration.readwise.import.importing-stop"]()}
            </Button>
          </DialogFooterActions>
        </Stack>
      ) : error ? (
        <Stack>
          <SettingsControlEmpty>
            {t["com.myoxus.integration.readwise.import.error"]()}
          </SettingsControlEmpty>
          <DialogFooterActions>
            <Button onClick={handleRetryCrawl}>
              {t["com.myoxus.integration.readwise.import.retry"]()}
            </Button>
          </DialogFooterActions>
        </Stack>
      ) : (
        <SelectStage
          loading={loading}
          highlights={highlights}
          onClose={onClose}
          onConfirm={handleConfirm}
          onResetTimestamp={handleRetryCrawl}
        />
      )}
    </Modal>
  );
};
