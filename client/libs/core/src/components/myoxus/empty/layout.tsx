import { EmptyState, ThemedImg } from "@myoxus/ui-facade";

import type { EmptyLayoutProps } from "./types";

export const EmptyLayout = ({
  className,
  illustrationLight,
  illustrationDark,
  illustrationWidth,
  title,
  description,
  action,
  absoluteCenter,
  "data-myoxus-ui-role": uiRole,
  ...attrs
}: EmptyLayoutProps) => {
  return (
    <EmptyState
      {...attrs}
      absoluteCenter={absoluteCenter}
      className={className}
      cta={action}
      data-myoxus-ui-role={uiRole ?? "empty-state-panel"}
      description={description}
      media={
        <ThemedImg
          draggable={false}
          fluid
          lightSrc={illustrationLight}
          darkSrc={illustrationDark}
        />
      }
      mediaWidth={illustrationWidth}
      title={title}
    />
  );
};
