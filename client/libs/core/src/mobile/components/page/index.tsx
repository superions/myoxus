import { MobileWorkspacePageRoot } from "@myoxus/ui-facade";
import { type HTMLAttributes, type ReactNode, useEffect } from "react";

import { AppTabs } from "../app-tabs";

interface PageProps extends HTMLAttributes<HTMLElement> {
  tab?: boolean;
  header?: ReactNode;
}

/**
 * A Page is a full-screen container that will not scroll on document.
 */
export const Page = ({ children, tab = true, header, ...attrs }: PageProps) => {
  // disable scroll on body
  useEffect(() => {
    const prevOverflowY = document.body.style.overflowY;
    document.body.style.overflowY = "hidden";
    return () => {
      document.body.style.overflowY = prevOverflowY;
    };
  }, []);

  return (
    <MobileWorkspacePageRoot component="main" bounded {...attrs} data-tab={tab}>
      {header}
      {children}
      {tab ? <AppTabs fixed={false} /> : null}
    </MobileWorkspacePageRoot>
  );
};
