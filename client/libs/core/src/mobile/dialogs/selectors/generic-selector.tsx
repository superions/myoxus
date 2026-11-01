import { PageHeader } from "@myoxus/core/mobile/components";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import {
  Button,
  Checkbox,
  MobileSelectorFooter,
  MobileSelectorFooterActions,
  MobileSelectorFooterInfo,
  MobileSelectorHeaderTitle,
  MobileSelectorIconSlot,
  MobileSelectorItemLabel,
  MobileSelectorList,
  MobileSelectorListItem,
  MobileSelectorRoot,
  MobileSelectorScrollArea,
  MobileSelectorScrollViewport,
  MobileSelectorTouchRail,
  MyoxusText,
  Scrollable,
  useThemeColorMeta,
} from "@myoxus/ui-facade";
import {
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface GenericSelectorProps {
  title?: ReactNode;
  onBack?: () => void;
  onConfirm?: (ids: string[]) => void;
  confirmText?: string;
  initial: string[];
  data: Array<{ id: string; icon: ReactNode; label: ReactNode }>;
  // totalRenderer?: (props: { total: number }) => ReactNode;
  // changedRenderer?: (props: { added: number; removed: number }) => ReactNode;
  // removeWarningType?: string;
  // removeWarningWhere?: string;
  typeName: string;
  onBeforeConfirm?: (ids: string[], cb: () => void) => void;
}

const ChangedRenderer = ({
  type,
  added,
  removed,
}: {
  added: number;
  removed: number;
  type: string;
}) => {
  const t = useI18n();

  const addedText = added
    ? t["com.myoxus.m.selector.info-added"]({ count: `${added}`, type })
    : "";
  const removedText = removed
    ? t["com.myoxus.m.selector.info-removed"]({
        count: `${removed}`,
        type,
      })
    : "";
  const connector = added && removed ? " · " : "";
  return addedText + connector + removedText;
};

export const GenericSelector = ({
  initial: originalInitial,
  data,
  title,
  confirmText,
  typeName,
  onBack,
  onConfirm,
  onBeforeConfirm,
}: GenericSelectorProps) => {
  const t = useI18n();
  useThemeColorMeta(cssVar("backgroundSecondaryColor"));
  const listRef = useRef<HTMLUListElement>(null);
  const quickScrollRef = useRef<HTMLDivElement>(null);

  const typeText = typeName;

  // make sure "initial ids" exist in list
  const [initial] = useState(
    originalInitial.filter((id) => data.some((el) => el.id === id)),
  );
  const [selected, setSelected] = useState(initial);

  const added = useMemo(
    () => selected.filter((id) => !initial.includes(id)),
    [initial, selected],
  );
  const removed = useMemo(
    () => initial.filter((id) => !selected.includes(id)),
    [initial, selected],
  );
  const disableConfirm = added.length === 0 && removed.length === 0;

  const handleToggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((v) => v !== id);
      } else {
        return [...prev, id];
      }
    });
  }, []);
  const handleConfirm = useCallback(() => {
    if (onBeforeConfirm) {
      onBeforeConfirm(selected, () => {
        onConfirm?.(selected);
      });
    } else {
      onConfirm?.(selected);
    }
  }, [onBeforeConfirm, onConfirm, selected]);

  // touch & move to select
  useEffect(() => {
    const quickSelect = quickScrollRef.current;
    if (!quickSelect) return;

    const onTouchStart = (e: TouchEvent) => {
      e.stopPropagation();
      e.preventDefault();

      // Drag-reversal tolerance derives from the Facade-owned touch rail width
      // so selector gesture behavior is not tied to a product-local pixel.
      const reverseThresholdPx = quickSelect.getBoundingClientRect().width / 4;
      let prevIndex: number | null = null;
      let prevY: number | null = null;
      let prevDir: "down" | "up" | null = null;
      let reverseAt: number | null = null;

      const check = (e: ReactTouchEvent<HTMLDivElement> | TouchEvent) => {
        const list = listRef.current;
        if (!list) return;
        const { clientY } = e.touches[0];
        if (clientY === prevY) return;

        const rect = list.getBoundingClientRect();
        const index = Math.floor(
          ((clientY - rect.top) / rect.height) * data.length,
        );

        const newDir = prevY === null ? null : clientY > prevY ? "down" : "up";
        const dirChanged = prevDir && newDir && newDir !== prevDir;
        const indexChanged = index !== prevIndex;

        if (dirChanged) {
          reverseAt = clientY;
        }
        const reverseAndMoved =
          reverseAt && Math.abs(clientY - reverseAt) > reverseThresholdPx;
        if (reverseAndMoved) {
          reverseAt = null;
        }

        if (
          index >= 0 &&
          index < data.length &&
          (reverseAndMoved || indexChanged)
        ) {
          handleToggleSelected(data[index].id);
        }

        // update prev
        prevIndex = index;
        prevY = clientY;
        prevDir = newDir;
      };
      check(e);

      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        check(e);
      };
      const onTouchEnd = () => {
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
      };

      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
    };

    quickSelect.addEventListener("touchstart", onTouchStart, {
      passive: false,
    });

    return () => {
      quickSelect.removeEventListener("touchstart", onTouchStart);
    };
  }, [data, handleToggleSelected]);

  return (
    <MobileSelectorRoot>
      <PageHeader back backAction={onBack}>
        <MobileSelectorHeaderTitle>
          {title ?? t["com.myoxus.m.selector.title"]({ type: typeText })}
        </MobileSelectorHeaderTitle>
      </PageHeader>
      <MobileSelectorScrollArea>
        <Scrollable.Scrollbar />
        <MobileSelectorScrollViewport>
          <MobileSelectorList ref={listRef}>
            {data.map(({ id, icon, label }) => {
              return (
                <MobileSelectorListItem
                  key={id}
                  onClick={() => handleToggleSelected(id)}
                >
                  <MobileSelectorIconSlot data-myoxus-ui-role="mobile-selector-checkbox-slot">
                    <Checkbox
                      checked={selected.includes(id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => handleToggleSelected(id)}
                    />
                  </MobileSelectorIconSlot>
                  <MobileSelectorIconSlot>{icon}</MobileSelectorIconSlot>
                  <MobileSelectorItemLabel>{label}</MobileSelectorItemLabel>
                  <MobileSelectorIconSlot
                    tone="disabled"
                    data-myoxus-ui-role="mobile-selector-row-disclosure"
                  >
                    <ArrowRightSmallIcon />
                  </MobileSelectorIconSlot>
                </MobileSelectorListItem>
              );
            })}
            <MobileSelectorTouchRail ref={quickScrollRef} />
          </MobileSelectorList>
        </MobileSelectorScrollViewport>
      </MobileSelectorScrollArea>
      <MobileSelectorFooter>
        <MobileSelectorFooterInfo>
          {!disableConfirm ? (
            <MyoxusText
              component="div"
              typographySlot="body"
              fallbackSlot="body-small"
              tone="primary"
              data-myoxus-ui-role="mobile-selector-change-summary"
            >
              <ChangedRenderer
                added={added.length}
                removed={removed.length}
                type={typeText}
              />
            </MyoxusText>
          ) : null}

          <MyoxusText
            component="div"
            typographySlot="body-small"
            tone="tertiary"
            data-myoxus-ui-role="mobile-selector-total-summary"
          >
            {t["com.myoxus.m.selector.info-total"]({
              total: initial.length + "",
            })}
          </MyoxusText>
        </MobileSelectorFooterInfo>
        <MobileSelectorFooterActions>
          <Button
            disabled={disableConfirm}
            variant="primary"
            block
            onClick={handleConfirm}
          >
            {confirmText ?? t["com.myoxus.m.selector.confirm-default"]()}
          </Button>
        </MobileSelectorFooterActions>
      </MobileSelectorFooter>
    </MobileSelectorRoot>
  );
};
