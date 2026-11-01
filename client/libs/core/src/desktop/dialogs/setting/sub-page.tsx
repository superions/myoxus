import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { type Island } from "@myoxus/core/utils/island";
import { ArrowLeftBigIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Button,
  Scrollable,
  SettingsDialogContentCenter,
  SettingsDialogContentPanel,
  SettingsSubPageContentViewport,
  SettingsSubPageHeader,
  SettingsSubPageMask,
  SettingsSubPagePanel,
  SettingsSubPageScrollRoot,
  SettingsSubPageTargetRoot,
} from "./primitives";

export interface SubPageContextType {
  islands: Island[];
  addIsland: () => {
    island: Island;
    dispose: () => void;
  };
}
export const SubPageContext = createContext<SubPageContextType>({
  islands: [],
  addIsland: () => ({
    // must be initialized
    island: null as unknown as Island,
    dispose: () => {},
  }),
});

const SubPageTargetItem = ({ island }: { island: Island }) => {
  const provided = useLiveData(island.provided$);

  return (
    <island.Target
      data-open={provided}
      data-setting-page
      component={SettingsSubPageTargetRoot}
    />
  );
};
export const SubPageTarget = () => {
  const context = useContext(SubPageContext);
  const islands = context.islands;
  return islands.map((island) => (
    <SubPageTargetItem key={island.id} island={island} />
  ));
};

const easing = "cubic-bezier(0.25, 0.36, 0.24, 0.97)";

// The previous settings page moves together with the active island. Native
// WAAPI owns this sibling choreography because a single Transition cannot.
const animateElement = (
  element: Element,
  keyframes: PropertyIndexedKeyframes,
  duration: number,
) => element.animate(keyframes, { duration, easing, fill: "forwards" });

export const SubPageProvider = ({
  island,
  open,
  onClose,
  children,
  backText = "Back",
  animation = true,
}: {
  island: Island;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  backText?: string;
  animation?: boolean;
}) => {
  const featureFlagService = useService(FeatureFlagService);
  const enableSettingSubpageAnimation = useLiveData(
    featureFlagService.flags.enable_setting_subpage_animation.$,
  );
  const duration = enableSettingSubpageAnimation ? (animation ? 320 : 0) : 0;

  const maskRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const [innerOpen, setInnerOpen] = useState(open);
  const [animateState, setAnimateState] = useState<
    "idle" | "ready" | "animating" | "finished"
  >("idle");
  const [played, setPlayed] = useState(false);

  const prevPageRef = useRef<HTMLDivElement>(null);

  const getPrevPage = useCallback((_root?: HTMLDivElement) => {
    const root = _root ?? pageRef.current?.parentElement;
    if (!root) {
      return null;
    }
    const prevPage = root.previousElementSibling as HTMLDivElement;
    if (!prevPage) {
      return null;
    }

    if (prevPage.dataset.settingPage && prevPage.dataset.open === "true") {
      prevPageRef.current = prevPage;
      return prevPage;
    }
    return getPrevPage(prevPage);
  }, []);

  const animateOpen = useCallback(() => {
    setAnimateState("animating");
    requestAnimationFrame(() => {
      const mask = maskRef.current;
      const page = pageRef.current;
      if (!mask || !page) {
        setAnimateState("idle");
        return;
      }
      animateElement(mask, { opacity: [0, 1] }, duration);
      animateElement(
        page,
        { transform: ["translateX(100%)", "translateX(0)"] },
        duration,
      )
        .finished.then(() => setAnimateState("finished"))
        .catch(console.error)
        .finally(() => {
          setAnimateState("finished");
          setPlayed(true);
        });

      const prevPage = getPrevPage();
      if (!prevPage) return;
      animateElement(
        prevPage,
        { transform: ["translateX(0)", "translateX(-20%)"] },
        duration,
      );
    });
  }, [duration, getPrevPage]);

  const animateClose = useCallback(() => {
    setAnimateState("animating");
    requestAnimationFrame(() => {
      const mask = maskRef.current;
      const page = pageRef.current;
      if (!mask || !page) {
        setAnimateState("idle");
        return;
      }
      animateElement(mask, { opacity: [1, 0] }, duration);
      animateElement(
        page,
        { transform: ["translateX(0)", "translateX(100%)"] },
        duration,
      )
        .finished.then(() => setAnimateState("idle"))
        .catch(console.error)
        .finally(() => setAnimateState("idle"));

      const prevPage = getPrevPage();
      if (!prevPage) return;
      animateElement(
        prevPage,
        { transform: ["translateX(-20%)", "translateX(0)"] },
        duration,
      );
    });
  }, [duration, getPrevPage]);

  useEffect(() => {
    setAnimateState("ready");
    setInnerOpen(open);
  }, [open]);

  useEffect(() => {
    if (animateState !== "ready") return;

    if (innerOpen) {
      animateOpen();
      return;
    }
    // the first played animation must be open
    if (!played) {
      setAnimateState("idle");
      return;
    }
    animateClose();
  }, [animateClose, animateOpen, animateState, innerOpen, played]);

  /**
   * for some situation like:
   *
   * ```tsx
   * const [open, setOpen] = useState(false);
   * if (!open) return null;
   * return <SubPageProvider open={open} onClose={() => setOpen(false)} />
   * ```
   *
   * The subpage is closed unexpectedly, so we need to reset the previous page's position.
   */
  useEffect(() => {
    return () => {
      const prevPage = prevPageRef.current;
      if (!prevPage) return;
      animateElement(prevPage, { transform: "translateX(0)" }, 0);
    };
  }, []);

  if (animateState === "idle") {
    return null;
  }

  return (
    <island.Provider>
      <SettingsSubPageMask ref={maskRef} />
      <SettingsSubPagePanel ref={pageRef}>
        <SettingsSubPageHeader>
          <Button
            data-testid="setting-subpage-back"
            onClick={onClose}
            prefix={<ArrowLeftBigIcon />}
            variant="plain"
          >
            {backText}
          </Button>
        </SettingsSubPageHeader>
        <SettingsSubPageScrollRoot>
          <SettingsSubPageContentViewport fill>
            <SettingsDialogContentCenter>
              <SettingsDialogContentPanel>
                {children}
              </SettingsDialogContentPanel>
            </SettingsDialogContentCenter>
            <Scrollable.Scrollbar />
          </SettingsSubPageContentViewport>
        </SettingsSubPageScrollRoot>
      </SettingsSubPagePanel>
    </island.Provider>
  );
};

/**
 * Create a new island when the component is mounted,
 * and dispose it when the component is unmounted.
 */
export const useSubPageIsland = () => {
  const { addIsland } = useContext(SubPageContext);
  const [island, setIsland] = useState<Island | null>(null);

  useEffect(() => {
    const { island, dispose } = addIsland();
    setIsland(island);
    return dispose;
  }, [addIsland]);

  return island;
};
