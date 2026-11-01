import { FindInPageService } from "@myoxus/core/modules/find-in-page";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  CloseIcon,
  SearchIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  FindInPageAnchor,
  FindInPageCanvasText,
  FindInPageCloseButton,
  FindInPageCount,
  FindInPageInputMain,
  FindInPageNavButton,
  FindInPageNavGroup,
  FindInPagePanel,
  FindInPageSearchBox,
  FindInPageSearchIconSlot,
  FindInPageTextInput,
  observeResize,
} from "@myoxus/ui-facade";
import {
  type CompositionEventHandler,
  type KeyboardEventHandler,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const drawText = (
  canvas: HTMLCanvasElement,
  text: string,
  scrollLeft: number,
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  // the container will be animated,
  // so we need to use clientWidth and clientHeight instead of getBoundingClientRect
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;

  const canvasStyles = getComputedStyle(canvas);
  const resolvedFont =
    canvasStyles.font ||
    `${canvasStyles.fontWeight} ${canvasStyles.fontSize}/${canvasStyles.lineHeight} ${canvasStyles.fontFamily}`.trim();
  const resolvedColor = canvasStyles.color.trim();
  const resolvedLetterSpacing = canvasStyles.letterSpacing.trim();

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const offsetX = -scrollLeft;
  if (resolvedColor) {
    ctx.fillStyle = resolvedColor;
  }
  if (resolvedFont) {
    ctx.font = resolvedFont;
  }
  if (resolvedLetterSpacing && resolvedLetterSpacing !== "normal") {
    ctx.letterSpacing = resolvedLetterSpacing;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, offsetX, canvas.clientHeight / 2);
};

const CanvasText = ({
  text,
  scrollLeft,
}: {
  text: string;
  scrollLeft: number;
}) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) {
      return;
    }
    drawText(canvas, text, scrollLeft);
    return observeResize(canvas, () => drawText(canvas, text, scrollLeft));
  }, [text, scrollLeft]);

  return <FindInPageCanvasText ref={ref} />;
};

export const FindInPagePopup = () => {
  const [value, setValue] = useState("");

  const findInPage = useService(FindInPageService).findInPage;
  const visible = useLiveData(findInPage.visible$);
  const result = useLiveData(findInPage.result$);
  const isSearching = useLiveData(findInPage.isSearching$);

  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    setValue(findInPage.searchText$.value || "");
  }, [findInPage.searchText$.value, visible]);

  const handleValueChange = useCallback(
    (value: string) => {
      setValue(value);
      if (!composing) {
        findInPage.findInPage(value);
      }
      if (value.length === 0) {
        findInPage.clear();
      }
      inputRef.current?.focus();
    },
    [composing, findInPage],
  );

  const handleFocus = useCallback(() => {
    setActive(true);
  }, []);

  const handleBlur = useCallback(() => {
    setActive(false);
  }, []);

  useEffect(() => {
    const unsub = findInPage.isSearching$.subscribe(() => {
      inputRef.current?.focus();
      setTimeout(() => {
        inputRef.current?.focus();
      });
    });

    return () => {
      unsub.unsubscribe();
    };
  }, [findInPage.isSearching$]);

  const handleBackWard = useCallback(() => {
    findInPage.backward();
  }, [findInPage]);

  const handleForward = useCallback(() => {
    findInPage.forward();
  }, [findInPage]);

  const onChangeVisible = useCallback(
    (visible: boolean) => {
      if (!visible) {
        findInPage.clear();
      }
      findInPage.onChangeVisible(visible);
    },
    [findInPage],
  );

  const handleDone = useCallback(() => {
    onChangeVisible(false);
  }, [onChangeVisible]);

  const handleKeydown: KeyboardEventHandler = useCallback(
    (e) => {
      if (e.key === "Enter" || e.key === "ArrowDown") {
        handleForward();
      }
      if (e.key === "ArrowUp") {
        handleBackWard();
      }
    },
    [handleBackWard, handleForward],
  );

  const handleScroll = useCallback(
    (e: { currentTarget: { scrollLeft: SetStateAction<number> } }) => {
      setScrollLeft(e.currentTarget.scrollLeft);
    },
    [],
  );

  const handleCompositionStart: CompositionEventHandler<HTMLInputElement> =
    useCallback(() => {
      setComposing(true);
    }, []);

  const handleCompositionEnd: CompositionEventHandler<HTMLInputElement> =
    useCallback(
      (e) => {
        setComposing(false);
        findInPage.findInPage(e.currentTarget.value);
      },
      [findInPage],
    );

  return (
    <FindInPageAnchor>
      <FindInPagePanel opened={visible}>
        <FindInPageSearchBox active={active || isSearching}>
          <FindInPageSearchIconSlot>
            <SearchIcon />
          </FindInPageSearchIconSlot>
          <FindInPageInputMain>
            <FindInPageTextInput
              type="text"
              autoFocus
              aria-label="Find in page"
              value={value}
              ref={inputRef}
              searching={isSearching}
              onBlur={handleBlur}
              onFocus={handleFocus}
              onKeyDown={handleKeydown}
              onChange={handleValueChange}
              onScroll={handleScroll}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
            />
            <CanvasText text={value} scrollLeft={scrollLeft} />
          </FindInPageInputMain>
          <FindInPageCount>
            {value.length > 0 && result && result.matches !== 0 ? (
              <>
                <span>{result?.activeMatchOrdinal || 0}</span>
                <span>/</span>
                <span>{result?.matches || 0}</span>
              </>
            ) : value.length ? (
              <span>No matches</span>
            ) : null}
          </FindInPageCount>
        </FindInPageSearchBox>

        <FindInPageNavGroup>
          <FindInPageNavButton
            edge="start"
            aria-label="Previous match"
            onClick={handleBackWard}
            icon={<ArrowUpSmallIcon />}
          />
          <FindInPageNavButton
            edge="end"
            aria-label="Next match"
            onClick={handleForward}
            icon={<ArrowDownSmallIcon />}
          />
        </FindInPageNavGroup>

        <FindInPageCloseButton
          aria-label="Close find in page"
          onClick={handleDone}
          icon={<CloseIcon />}
        />
      </FindInPagePanel>
    </FindInPageAnchor>
  );
};
