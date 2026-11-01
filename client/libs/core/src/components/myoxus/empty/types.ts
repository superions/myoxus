import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

export interface EmptyLayoutProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "title"
> {
  illustrationLight: string;
  illustrationDark?: string;
  illustrationWidth?: CSSProperties["width"];
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  "data-myoxus-ui-role"?: string;
  [key: `data-${string}`]: unknown;

  /**
   * Absolute center the content, useful for full screen empty states (e.g. mobile page)
   */
  absoluteCenter?: boolean;
}

export type UniversalEmptyProps = Partial<EmptyLayoutProps>;
