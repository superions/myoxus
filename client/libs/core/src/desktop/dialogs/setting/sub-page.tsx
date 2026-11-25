// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ArrowLeftBigIcon } from "@myoxus/icons/react";
import {
  createContext,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";

import {
  Box,
  Divider,
  NavLink,
  Stack,
  WorkspaceDetailSkeleton,
} from "./primitives";

export interface SettingsSubPageEntry {
  id: string;
  backText: string;
  onClose: () => void;
}

export interface SubPageContextType {
  subPages: SettingsSubPageEntry[];
  activeSubPageId: string | null;
  portalTarget: HTMLDivElement | null;
  upsertSubPage: (entry: SettingsSubPageEntry) => void;
  removeSubPage: (id: string) => void;
}

export const SubPageContext = createContext<SubPageContextType>({
  subPages: [],
  activeSubPageId: null,
  portalTarget: null,
  upsertSubPage: () => {},
  removeSubPage: () => {},
});

export const SubPageView = ({
  backText,
  onClose,
  children,
}: {
  backText: string;
  onClose: () => void;
  children: ReactNode;
}) => {
  return (
    <Stack gap="md" data-myoxus-ui-role="settings-subpage">
      <NavLink
        component="button"
        type="button"
        data-testid="setting-subpage-back"
        leftSection={<ArrowLeftBigIcon />}
        label={backText}
        onClick={onClose}
      />
      <Divider />
      <Suspense fallback={<WorkspaceDetailSkeleton />}>{children}</Suspense>
    </Stack>
  );
};

export const SubPageProvider = ({
  open,
  onClose,
  children,
  backText = "Back",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  backText?: string;
}) => {
  const id = useId();
  const { activeSubPageId, portalTarget, upsertSubPage, removeSubPage } =
    useContext(SubPageContext);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      removeSubPage(id);
      return;
    }
    upsertSubPage({
      id,
      backText,
      onClose: () => onCloseRef.current(),
    });
  }, [backText, id, open, removeSubPage, upsertSubPage]);

  useEffect(() => {
    return () => {
      removeSubPage(id);
    };
  }, [id, removeSubPage]);

  if (!open || !portalTarget) {
    return null;
  }

  return createPortal(
    <Box hidden={activeSubPageId !== id}>
      <SubPageView backText={backText} onClose={() => onCloseRef.current()}>
        {children}
      </SubPageView>
    </Box>,
    portalTarget,
  );
};
