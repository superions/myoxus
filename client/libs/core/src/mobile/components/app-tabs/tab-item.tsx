import { GlobalCacheService } from "@myoxus/core/modules/storage";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { MobileAppTabsItem } from "@myoxus/ui-facade";
import {
  type ElementType,
  type PropsWithChildren,
  type Ref,
  useCallback,
  useMemo,
} from "react";

import { cacheKey } from "./constants";

export interface TabItemProps extends PropsWithChildren {
  triggerRef?: Ref<HTMLElement>;
  pending?: boolean;
  activateOnClick?: boolean;
  component?: ElementType;
  id: string;
  label: string;
  onClick?: (isActive: boolean) => void;
  replaceHistory?: boolean;
  to?: unknown;
}

export const TabItem = ({
  children,
  component,
  id,
  label,
  onClick,
  replaceHistory,
  to,
  triggerRef,
  pending,
  activateOnClick = true,
}: TabItemProps) => {
  const globalCache = useService(GlobalCacheService).globalCache;
  const activeTabId$ = useMemo(
    () => LiveData.from(globalCache.watch(cacheKey), "home"),
    [globalCache],
  );
  const activeTabId = useLiveData(activeTabId$) ?? "home";

  const isActive = id === activeTabId;

  const handleClick = useCallback(() => {
    if (pending) return;
    if (activateOnClick) globalCache.set(cacheKey, id);
    onClick?.(isActive);
  }, [globalCache, id, isActive, onClick, pending, activateOnClick]);

  return (
    <MobileAppTabsItem
      ref={triggerRef}
      aria-busy={pending}
      aria-disabled={pending}
      active={isActive}
      aria-label={label}
      component={component}
      onClick={handleClick}
      replaceHistory={replaceHistory}
      to={to}
    >
      {children}
    </MobileAppTabsItem>
  );
};
