// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { Center, Group, MyoxusLoader, MyoxusText } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function ArtifactSkeleton({ icon }: { icon: ReactNode }) {
  const t = useI18n();
  return (
    <Center h="100%" role="status" aria-busy="true">
      <Group>
        {icon}
        <MyoxusLoader />
        <MyoxusText>{t["com.myoxus.ai.chat-panel.generating"]()}</MyoxusText>
      </Group>
    </Center>
  );
}
