import { ConfigModal } from "@myoxus/core/components/mobile";
import { DualLinkIcon } from "@myoxus/icons/react";
import { SurfaceListItemFrame, SurfaceListText } from "@myoxus/ui-facade";
import type { PropsWithChildren, ReactNode } from "react";

export const RowLayout = ({
  label,
  children,
  href,
  onClick,
}: PropsWithChildren<{
  label: ReactNode;
  href?: string;
  onClick?: () => void;
}>) => {
  const content = (
    <ConfigModal.Row
      data-testid="setting-row"
      onClick={onClick}
      right={children || (href ? <DualLinkIcon aria-hidden /> : null)}
    >
      <SurfaceListText kind="title">{label}</SurfaceListText>
    </ConfigModal.Row>
  );

  return href ? (
    <SurfaceListItemFrame
      component="a"
      target="_blank"
      href={href}
      rel="noreferrer"
      data-myoxus-ui-role="mobile-setting-external-link"
    >
      {content}
    </SurfaceListItemFrame>
  ) : (
    content
  );
};
