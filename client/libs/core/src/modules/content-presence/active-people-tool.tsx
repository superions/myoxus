// SPDX-License-Identifier: AGPL-3.0-or-later

import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { Group, Stack, Avatar, MyoxusText, Loading } from "@myoxus/ui-facade";

export interface ActivePerson {
  key: string;
  name: string;
  local: boolean;
  color?: string;
}

const PRESENCE_VIEW_FAMILIES = [
  "document-page",
  "document-edgeless",
  "journal",
  "database",
] as const;

export function ActivePeopleTool({
  people,
  connected,
}: {
  people: readonly ActivePerson[] | null;
  connected: boolean | null;
}) {
  const t = useI18n();
  return (
    <ViewContextSurface
      surfaceId="presence"
      label={t["com.myoxus.presence.title"]()}
      icon={null}
      viewFamilies={PRESENCE_VIEW_FAMILIES}
    >
      <Stack gap="xs">
        {connected === null || people === null ? (
          <Loading />
        ) : !connected ? (
          <MyoxusText>{t["com.myoxus.presence.unavailable"]()}</MyoxusText>
        ) : (
          <>
            {people.map((person) => (
              <Group key={person.key} gap="xs" wrap="nowrap">
                <Avatar
                  name={person.name}
                  size="sm"
                  rounded="50%"
                  color={person.color ?? "initials"}
                />
                <MyoxusText>{person.name}</MyoxusText>
                {person.local ? (
                  <MyoxusText tone="secondary">
                    {t["com.myoxus.common.you"]()}
                  </MyoxusText>
                ) : null}
              </Group>
            ))}
            {!people.some((person) => !person.local) ? (
              <MyoxusText>{t["com.myoxus.presence.only-you"]()}</MyoxusText>
            ) : null}
          </>
        )}
      </Stack>
    </ViewContextSurface>
  );
}
