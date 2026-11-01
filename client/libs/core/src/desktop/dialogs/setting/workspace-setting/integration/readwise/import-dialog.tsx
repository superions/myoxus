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

// The virtualized highlight list needs a bounded block size. Keep the dialog
// dimensions token-bound at the modal boundary instead of route-local CSS.
const READWISE_IMPORT_DIALOG_HEIGHT =
  "min(65vh, calc(100dvh - var(--mantine-spacing-2xl)))";

export const ImportDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const crawler = readwise.crawler;

  const [importProgress, setImportProgress] = useState(0);
  const crawlingData = useLiveData(crawler.data$);
  const error = useLiveData(crawler.error$);
  const loading = useLiveData(crawler.crawling$);

  const highlights = useMemo(
    () => crawlingData?.highlights ?? [],
    [crawlingData],
  );
  const books = useMemo(() => crawlingData?.books ?? {}, [crawlingData]);
  const timestamp = crawlingData?.startTime;
  const [stage, setStage] = useState<"select" | "writing">("select");
  const abortControllerRef = useRef<AbortController | null>(null);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const handleConfirmImport = useCallback(
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
      const selectedHighlights = highlights.filter((h) => ids.includes(h.id));

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const signal = abortController.signal;

      const startTime = Date.now();
      readwise
        .highlightsToMyoxusDocs(selectedHighlights.reverse(), books, {
          signal,
          onProgress: setImportProgress,
          onComplete: () => {
            readwiseTrack.completeIntegrationImport({
              total: selectedHighlights.length,
              done: selectedHighlights.length,
              time: (Date.now() - startTime) / 1000,
            });
            readwise.updateSetting("lastImportedAt", timestamp);
            onClose();
          },
          onAbort: (finished) => {
            readwiseTrack.abortIntegrationImport({
              total: selectedHighlights.length,
              done: finished,
              time: (Date.now() - startTime) / 1000,
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
  const handleStopImport = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStage("select");
    setImportProgress(0);
  }, []);

  const handleRetryCrawl = useCallback(() => {
    crawler.abort();
    crawler.crawl();
  }, [crawler]);

  useEffect(() => {
    return () => {
      // reset crawler
      crawler.reset();

      // stop importing
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [crawler]);

  useEffect(() => {
    crawler.crawl();

    return () => {
      crawler.abort();
    };
  }, [crawler]);

  return (
    <Modal
      open={true}
      width="lg"
      height={stage === "select" ? READWISE_IMPORT_DIALOG_HEIGHT : undefined}
      title={
        stage === "select"
          ? t["com.myoxus.integration.readwise.import.title"]()
          : t["com.myoxus.integration.readwise.import.importing"]()
      }
      description={
        stage === "writing"
          ? t["com.myoxus.integration.readwise.import.importing-desc"]()
          : undefined
      }
      contentOptions={{
        "data-testid": "readwise-import-dialog",
        style: { overflow: "hidden" },
      }}
      onOpenChange={onOpenChange}
      withoutCloseButton={stage === "writing"}
      persistent={stage === "writing"}
    >
      {stage === "select" ? (
        error ? (
          <CrawlerError onRetry={handleRetryCrawl} />
        ) : (
          <SelectStage
            loading={loading}
            highlights={highlights}
            onClose={onClose}
            onConfirm={handleConfirmImport}
            onResetLastImportedAt={handleRetryCrawl}
          />
        )
      ) : (
        <WritingStage progress={importProgress} onStop={handleStopImport} />
      )}
    </Modal>
  );
};

const CrawlerError = ({ onRetry }: { onRetry: () => void }) => {
  const t = useI18n();

  return (
    <Stack>
      <SettingsControlEmpty>
        {t["com.myoxus.integration.readwise.import.error"]()}
      </SettingsControlEmpty>
      <DialogFooterActions>
        <Button onClick={onRetry}>
          {t["com.myoxus.integration.readwise.import.retry"]()}
        </Button>
      </DialogFooterActions>
    </Stack>
  );
};

const SelectStage = ({
  loading,
  highlights,
  onClose,
  onConfirm,
  onResetLastImportedAt,
}: {
  loading: boolean;
  highlights: ReadwiseHighlight[];
  onClose: () => void;
  onConfirm: (ids: ReadwiseHighlight["id"][]) => void;
  onResetLastImportedAt: () => void;
}) => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const settings = useLiveData(readwise.settings$);
  const lastImportedAt = settings?.lastImportedAt;
  const [selected, setSelected] = useState<ReadwiseHighlight["id"][]>([]);

  const handleResetLastImportedAt = useCallback(() => {
    readwiseTrack.startIntegrationImport({
      method: "cleartimestamp",
      control: "Readwise import list",
    });
    readwise.updateSetting("lastImportedAt", undefined);
    onResetLastImportedAt();
  }, [onResetLastImportedAt, readwise]);

  const handleConfirmImport = useCallback(() => {
    onConfirm(selected);
  }, [onConfirm, selected]);

  // select all highlights when highlights changed
  useEffect(() => {
    if (!loading) {
      setSelected(highlights.map((h) => h.id));
    }
  }, [highlights, loading]);

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
                    handleResetLastImportedAt();
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
          <HighlightEmpty />
        )}
      </Stack>

      <DialogFooterActions>
        <Button onClick={onClose}>{t["Cancel"]()}</Button>
        <Button
          disabled={
            loading || (selected.length === 0 && highlights.length !== 0)
          }
          variant="primary"
          onClick={handleConfirmImport}
        >
          {t["Confirm"]()}
        </Button>
      </DialogFooterActions>
    </Stack>
  );
};

const Scroller = forwardRef<HTMLDivElement>(function Scroller(props, ref) {
  return (
    <Scrollable.VirtualizedViewport
      ref={ref}
      data-myoxus-ui-role="readwise-import-highlight-scroll"
      {...props}
    />
  );
});

const HighlightTable = ({
  selected,
  setSelected,
  highlights,
}: {
  selected: ReadwiseHighlight["id"][];
  setSelected: Dispatch<SetStateAction<ReadwiseHighlight["id"][]>>;
  highlights: ReadwiseHighlight[];
}) => {
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
          refs.reduce(
            (acc, ref) => {
              acc[ref.refMeta.highlightId] = ref.refMeta.updatedAt;
              return acc;
            },
            {} as Record<string, string>,
          ),
        );
      })
      .catch(console.error);
  }, [readwise]);

  const handleToggleSelectAll = useCallback(
    (_: ChangeEvent, checked: boolean) => {
      readwiseTrack.selectIntegrationImport({
        method: "all",
        option: checked ? "on" : "off",
        control: "Readwise import list",
      });
      setSelected(checked ? highlights.map((h) => h.id) : []);
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
        selectionActive={selected.length === highlights.length}
      >
        <SurfaceListHeaderSelectionSlot
          active={selected.length === highlights.length}
          selectable="toggle"
        >
          <Checkbox
            checked={selected.length === highlights.length}
            onChange={handleToggleSelectAll}
          />
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
        itemContent={(idx) => {
          const highlight = highlights[idx];
          const localUpdatedAt = updatedMap?.[highlight.id];
          const readwiseUpdatedAt = highlight.updated_at;
          const action = readwise.getAction({
            localUpdatedAt,
            remoteUpdatedAt: readwiseUpdatedAt,
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
              <SurfaceListSelectionSlot
                active={selected.includes(highlight.id)}
              >
                <Checkbox
                  checked={selected.includes(highlight.id)}
                  onChange={(_: ChangeEvent, checked: boolean) => {
                    readwiseTrack.selectIntegrationImport({
                      method: "single",
                      option: checked ? "on" : "off",
                      control: "Readwise import list",
                    });
                    setSelected(
                      checked
                        ? [...selected, highlight.id]
                        : selected.filter((id) => id !== highlight.id),
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
                    {i18nTime(readwiseUpdatedAt, {
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
        components={{ Scroller }}
      />
    </Stack>
  );
};
const HighlightEmpty = () => {
  const t = useI18n();
  return (
    <SettingsControlEmpty data-testid="readwise-import-empty">
      {t["com.myoxus.integration.readwise.import.empty"]()}
    </SettingsControlEmpty>
  );
};

const WritingStage = ({
  progress,
  onStop,
}: {
  progress: number;
  onStop: () => void;
}) => {
  const t = useI18n();
  return (
    <Stack data-myoxus-ui-role="readwise-import-writing-stage">
      <Progress
        value={progress}
        ariaLabel={t["com.myoxus.integration.readwise.import.importing"]()}
      />

      <DialogFooterActions>
        <Button variant="error" onClick={onStop}>
          {t["com.myoxus.integration.readwise.import.importing-stop"]()}
        </Button>
      </DialogFooterActions>
    </Stack>
  );
};
