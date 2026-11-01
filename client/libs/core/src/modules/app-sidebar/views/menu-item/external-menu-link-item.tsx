import { DualLinkIcon } from "@myoxus/icons/react";
import {
  type AnchorHTMLAttributes,
  forwardRef,
  type ReactElement,
  type SVGAttributes,
} from "react";
import type { To } from "react-router";

import { MenuLinkItem } from "./index";

const RawLink = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { to: To }
>(function RawLink({ children, to, ...props }, ref) {
  const href = typeof to === "string" ? to : to.pathname;
  return (
    <a {...props} ref={ref} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
});

export const ExternalMenuLinkItem = ({
  href,
  icon,
  label,
}: {
  href: string;
  icon: ReactElement<SVGAttributes<SVGElement>>;
  label: string;
}) => {
  return (
    <MenuLinkItem
      to={href}
      linkComponent={RawLink}
      icon={icon}
      postfix={<DualLinkIcon aria-hidden="true" />}
    >
      {label}
    </MenuLinkItem>
  );
};
