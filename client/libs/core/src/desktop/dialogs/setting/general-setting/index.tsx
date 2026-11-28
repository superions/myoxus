// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { UserSettingTab } from "@myoxus/core/modules/dialogs/constant";
import { UserFeatureService } from "@myoxus/core/modules/server/services/user-feature";
import { useI18n } from "@myoxus/i18n";
import {
  AppearanceIcon,
  ExperimentIcon,
  FolderIcon,
  InformationIcon,
  KeyboardIcon,
  LanguageIcon,
  MeetingIcon,
  NotificationIcon,
  PenIcon,
  TodayIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { useEffect, useMemo } from "react";

import { AuthService } from "../../../../modules/server";
import type { SettingSidebarItem } from "../types";
import { AboutMyoxus } from "./about";
import { AppearanceSettings } from "./appearance";
import { BackupSettingPanel } from "./backup";
import { EditorSettings } from "./editor";
import { ExperimentalFeatures } from "./experimental-features";
import { JournalSettings } from "./journal";
import { LanguageRegionSettings } from "./language-region";
import { MeetingsSettings } from "./meetings";
import { NotificationSettings } from "./notifications";
import { Shortcuts } from "./shortcuts";

export type GeneralSettingList = SettingSidebarItem<UserSettingTab>[];

export const useGeneralSettingList = (): GeneralSettingList => {
  const t = useI18n();
  const { authService, userFeatureService } = useServices({
    AuthService,
    UserFeatureService,
  });
  const isSignedIn =
    useLiveData(authService.session.status$) === "authenticated";

  useEffect(() => {
    userFeatureService.userFeature.revalidate();
  }, [userFeatureService]);

  return useMemo(() => {
    const items: GeneralSettingList = [
      {
        key: "appearance",
        title: t["com.myoxus.settings.appearance"](),
        icon: <AppearanceIcon />,
        testId: "appearance-panel-trigger",
      },
      {
        key: "editor",
        title: t["com.myoxus.settings.editorSettings"](),
        icon: <PenIcon />,
        testId: "editor-panel-trigger",
      },
      {
        key: "language-region",
        title: t["com.myoxus.settings.language-region"](),
        icon: <LanguageIcon />,
        testId: "language-region-panel-trigger",
      },
      {
        key: "shortcuts",
        title: t["com.myoxus.keyboardShortcuts.title"](),
        icon: <KeyboardIcon />,
        testId: "shortcuts-panel-trigger",
      },
      {
        key: "journal",
        title: t["com.myoxus.settings.journal"](),
        icon: <TodayIcon />,
        testId: "journal-panel-trigger",
      },
    ];

    if (isSignedIn) {
      items.push({
        key: "notifications",
        title: t["com.myoxus.setting.notifications"](),
        icon: <NotificationIcon />,
        testId: "notifications-panel-trigger",
      });
    }

    const supportsDesktopMeetings =
      BUILD_CONFIG.isElectron &&
      (environment.isMacOs || environment.isWindows || environment.isLinux);
    if (supportsDesktopMeetings) {
      items.push({
        key: "meetings",
        title: t["com.myoxus.settings.meetings"](),
        icon: <MeetingIcon />,
        testId: "meetings-panel-trigger",
      });
    }

    if (BUILD_CONFIG.isElectron) {
      items.push({
        key: "backup",
        title: t["com.myoxus.settings.workspace.backup"](),
        icon: <FolderIcon />,
        testId: "backup-panel-trigger",
      });
    }

    items.push(
      {
        key: "experimental-features",
        title: t["com.myoxus.settings.workspace.experimental-features"](),
        icon: <ExperimentIcon />,
        testId: "experimental-features-trigger",
      },
      {
        key: "about",
        title: t["com.myoxus.aboutMyoxus.title"](),
        icon: <InformationIcon />,
        testId: "about-panel-trigger",
      },
    );

    return items;
  }, [isSignedIn, t]);
};

export const GeneralSetting = ({
  activeTab,
}: {
  activeTab: UserSettingTab;
}) => {
  switch (activeTab) {
    case "appearance":
      return <AppearanceSettings />;
    case "editor":
      return <EditorSettings />;
    case "language-region":
      return <LanguageRegionSettings />;
    case "shortcuts":
      return <Shortcuts />;
    case "journal":
      return <JournalSettings />;
    case "notifications":
      return <NotificationSettings />;
    case "meetings":
      return <MeetingsSettings />;
    case "backup":
      return <BackupSettingPanel />;
    case "experimental-features":
      return <ExperimentalFeatures />;
    case "about":
      return <AboutMyoxus />;
    default:
      return null;
  }
};
