// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ArrowLeftBigIcon } from "@myoxus/icons/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
} from "react";

import { Divider, NavLink, Stack } from "./primitives";

export interface SettingsSubPageEntry {
  id: string;
  backText: string;
  onClose: () => void;
  content: ReactNode;
}

export interface SubPageContextType {
  subPages: SettingsSubPageEntry[];
  upsertSubPage: (entry: SettingsSubPageEntry) => void;
  removeSubPage: (id: string) => void;
}

export const SubPageContext = createContext<SubPageContextType>({
  subPages: [],
  upsertSubPage: () => {},
  removeSubPage: () => {},
});

export const SubPageView = ({ entry }: { entry: SettingsSubPageEntry }) => {
  return (
    <Stack gap="md" data-myoxus-ui-role="settings-subpage">
      <NavLink
        component="button"
        type="button"
        data-testid="setting-subpage-back"
        leftSection={<ArrowLeftBigIcon />}
        label={entry.backText}
        onClick={entry.onClose}
      />
      <Divider />
      {entry.content}
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
  const { upsertSubPage, removeSubPage } = useContext(SubPageContext);
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
      content: children,
    });
  }, [backText, children, id, open, removeSubPage, upsertSubPage]);

  useEffect(() => {
    return () => {
      removeSubPage(id);
    };
  }, [id, removeSubPage]);

  return null;
};
