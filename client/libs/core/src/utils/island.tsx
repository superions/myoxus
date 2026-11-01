import { LiveData, useLiveData } from "@myoxus/infra";
import { nanoid } from "nanoid";
import {
  type ElementType,
  forwardRef,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { createPortal } from "react-dom";

export const createIsland = () => {
  const targetLiveData$ = new LiveData<HTMLDivElement | null>(null);
  const provided$ = new LiveData<boolean>(false);
  let mounted = false;
  return {
    id: nanoid(),
    Target: forwardRef(function IslandTarget(
      {
        component: TargetComponent = "div",
        ...other
      }: React.HTMLProps<HTMLDivElement> & { component?: ElementType },
      ref: Ref<HTMLDivElement>,
    ) {
      const target = useRef<HTMLDivElement | null>(null);

      useImperativeHandle(ref, () => target.current as HTMLDivElement, []);
      useEffect(() => {
        if (mounted === true) {
          throw new Error("Island should not be mounted more than once");
        }
        mounted = true;
        targetLiveData$.next(target.current);
        return () => {
          mounted = false;
          targetLiveData$.next(null);
        };
      }, []);
      return <TargetComponent {...other} ref={target}></TargetComponent>;
    }),
    Provider: ({ children }: React.PropsWithChildren) => {
      const target = useLiveData(targetLiveData$);
      useEffect(() => {
        if (provided$.value === true && BUILD_CONFIG.debug) {
          throw new Error("Island should not be provided more than once");
        }
        provided$.next(true);
        return () => {
          provided$.next(false);
        };
      }, []);
      return target ? createPortal(children, target) : null;
    },
    provided$,
  };
};

export type Island = ReturnType<typeof createIsland>;
