// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

function paintSearchText(
  canvas: HTMLCanvasElement,
  text: string,
  scrollLeft: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  // Use client dimensions rather than getBoundingClientRect while the panel animates.
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;

  const computed = getComputedStyle(canvas);
  const font =
    computed.font ||
    `${computed.fontWeight} ${computed.fontSize}/${computed.lineHeight} ${computed.fontFamily}`.trim();
  const color = computed.color.trim();
  const letterSpacing = computed.letterSpacing.trim();

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (color) {
    ctx.fillStyle = color;
  }
  if (font) {
    ctx.font = font;
  }
  if (letterSpacing && letterSpacing !== "normal") {
    ctx.letterSpacing = letterSpacing;
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, -scrollLeft, canvas.clientHeight / 2);
}

function SearchCanvasMirror({
  text,
  scrollLeft,
}: {
  text: string;
  scrollLeft: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    paintSearchText(canvas, text, scrollLeft);
    return observeResize(canvas, () =>
      paintSearchText(canvas, text, scrollLeft),
    );
  }, [scrollLeft, text]);

  return <FindInPageCanvasText ref={canvasRef} />;
}

export function FindInPagePopup() {
  const findInPage = useService(FindInPageService).findInPage;
  const visible = useLiveData(findInPage.visible$);
  const result = useLiveData(findInPage.result$);
  const isSearching = useLiveData(findInPage.isSearching$);

  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(findInPage.searchText$.value || "");
  }, [findInPage.searchText$.value, visible]);

  useEffect(() => {
    const subscription = findInPage.isSearching$.subscribe(() => {
      inputRef.current?.focus();
      setTimeout(() => {
        inputRef.current?.focus();
      });
    });
    return () => subscription.unsubscribe();
  }, [findInPage.isSearching$]);

  const handleChange = useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      if (!composing) {
        findInPage.findInPage(nextValue);
      }
      if (nextValue.length === 0) {
        findInPage.clear();
      }
      inputRef.current?.focus();
    },
    [composing, findInPage],
  );

  const handlePrevious = useCallback(() => {
    findInPage.backward();
  }, [findInPage]);

  const handleNext = useCallback(() => {
    findInPage.forward();
  }, [findInPage]);

  const handleClose = useCallback(() => {
    findInPage.clear();
    findInPage.onChangeVisible(false);
  }, [findInPage]);

  const handleKeyDown: KeyboardEventHandler = useCallback(
    (event) => {
      if (event.key === "Enter" || event.key === "ArrowDown") {
        handleNext();
      } else if (event.key === "ArrowUp") {
        handlePrevious();
      }
    },
    [handleNext, handlePrevious],
  );

  const handleScroll = useCallback(
    (event: { currentTarget: { scrollLeft: SetStateAction<number> } }) => {
      setScrollLeft(event.currentTarget.scrollLeft);
    },
    [],
  );

  const handleCompositionStart: CompositionEventHandler<HTMLInputElement> =
    useCallback(() => {
      setComposing(true);
    }, []);

  const handleCompositionEnd: CompositionEventHandler<HTMLInputElement> =
    useCallback(
      (event) => {
        setComposing(false);
        findInPage.findInPage(event.currentTarget.value);
      },
      [findInPage],
    );

  return (
    <FindInPageAnchor>
      <FindInPagePanel opened={visible}>
        <FindInPageSearchBox active={focused || isSearching}>
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
              onBlur={() => setFocused(false)}
              onFocus={() => setFocused(true)}
              onKeyDown={handleKeyDown}
              onChange={handleChange}
              onScroll={handleScroll}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
            />
            <SearchCanvasMirror text={value} scrollLeft={scrollLeft} />
          </FindInPageInputMain>
          <FindInPageCount>
            {value.length > 0 && result && result.matches !== 0 ? (
              <>
                <span>{result.activeMatchOrdinal || 0}</span>
                <span>/</span>
                <span>{result.matches || 0}</span>
              </>
            ) : value.length > 0 ? (
              <span>No matches</span>
            ) : null}
          </FindInPageCount>
        </FindInPageSearchBox>

        <FindInPageNavGroup>
          <FindInPageNavButton
            edge="start"
            aria-label="Previous match"
            onClick={handlePrevious}
            icon={<ArrowUpSmallIcon />}
          />
          <FindInPageNavButton
            edge="end"
            aria-label="Next match"
            onClick={handleNext}
            icon={<ArrowDownSmallIcon />}
          />
        </FindInPageNavGroup>

        <FindInPageCloseButton
          aria-label="Close find in page"
          onClick={handleClose}
          icon={<CloseIcon />}
        />
      </FindInPagePanel>
    </FindInPageAnchor>
  );
}
