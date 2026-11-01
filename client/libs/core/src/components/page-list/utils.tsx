import { SurfaceListCell } from "@myoxus/ui-facade";
import { forwardRef } from "react";

import type { ColWrapperProps } from "./types";

export const ColWrapper = forwardRef<HTMLDivElement, ColWrapperProps>(
  function ColWrapper(
    {
      flex,
      alignment,
      hideInSmallContainer,
      hidden,
      className,
      style,
      children,
      ...rest
    }: ColWrapperProps,
    ref,
  ) {
    return (
      <SurfaceListCell
        {...rest}
        data-hide-item={hideInSmallContainer ? true : undefined}
        data-testid="page-list-flex-wrapper"
        alignment={alignment}
        className={className}
        flex={flex}
        hidden={hidden}
        hideInCompact={hideInSmallContainer}
        ref={ref}
        style={style}
      >
        {children}
      </SurfaceListCell>
    );
  },
);

export const withinDaysAgo = (date: Date, days: number): boolean => {
  const startDate = new Date();
  const day = startDate.getDate();
  const month = startDate.getMonth();
  const year = startDate.getFullYear();
  return new Date(year, month, day - days + 1) <= date;
};

export const betweenDaysAgo = (
  date: Date,
  days0: number,
  days1: number,
): boolean => {
  return !withinDaysAgo(date, days0) && withinDaysAgo(date, days1);
};
