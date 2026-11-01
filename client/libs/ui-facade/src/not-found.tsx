// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ReactElement } from "react";
import { useI18n } from "@myoxus/i18n";
import { Group, Stack, Container as MantineContainer } from "@mantine/core";
import { Avatar } from "./avatar";
import { MyoxusText, MyoxusTitle } from "./typography";
import { IconButton, Button } from "./button";
import { SignOutIcon } from "@myoxus/icons/react";
import { MyoxusOtherPageLayout, AuthBackgroundArt } from "./auth-layout";

export interface User {
  id: string;
  label: string;
  email?: string;
  image?: string | null;
  avatar?: string | null;
}

export interface NotFoundPageProps {
  user?: User | null;
  signInComponent?: ReactElement;
  onBack: () => void;
  onSignOut: () => void;
}

function NotFoundAccountLine({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => void;
}) {
  const t = useI18n();
  return (
    <Group justify="center" gap="sm" data-myoxus-ui-role="not-found-account">
      <Avatar url={user.avatar ?? user.image} name={user.label} />
      <MyoxusText component="span" tone="secondary" typographySlot="body-small">
        {user.email}
      </MyoxusText>
      <IconButton
        onClick={onSignOut}
        size="default"
        aria-label={t["404.signOut"]()}
        tooltip={t["404.signOut"]()}
        icon={<SignOutIcon />}
      />
    </Group>
  );
}

function NotFoundContent({
  user,
  onBack,
  onSignOut,
}: Omit<NotFoundPageProps, "signInComponent">) {
  const t = useI18n();
  return (
    <Stack align="center" gap="xl" data-myoxus-ui-role="not-found-content">
      <MyoxusTitle
        order={1}
        textAlign="center"
        tone="tertiary"
        typographySlot="page-title"
        m={0}
        data-myoxus-ui-role="not-found-label"
      >
        404
      </MyoxusTitle>
      <MyoxusTitle
        order={2}
        textAlign="center"
        typographySlot="section-title"
        maw="32rem"
        m={0}
        data-myoxus-ui-role="not-found-title"
      >
        {t["com.myoxus.notFoundPage.title"]()}
      </MyoxusTitle>
      <MyoxusText
        component="p"
        tone="secondary"
        typographySlot="body-large"
        textAlign="center"
        maw="32rem"
        m={0}
        data-myoxus-ui-role="not-found-description"
      >
        {t["404.hint"]()}
      </MyoxusText>
      <Group justify="center" data-myoxus-ui-role="not-found-actions">
        <Button variant="secondary" size="large" onClick={onBack}>
          {t["404.back"]()}
        </Button>
      </Group>
      {user ? <NotFoundAccountLine user={user} onSignOut={onSignOut} /> : null}
    </Stack>
  );
}

export function NoPermissionOrNotFound({
  user,
  onBack,
  onSignOut,
  signInComponent,
}: NotFoundPageProps) {
  return (
    <MyoxusOtherPageLayout>
      <AuthBackgroundArt />
      <MantineContainer
        component="main"
        py="xl"
        pos="relative"
        size={620}
        style={{ zIndex: 1 }}
        data-testid="not-found"
        data-myoxus-error-status="404"
        data-myoxus-ui-role="empty-state-panel"
      >
        {user ? (
          <NotFoundContent user={user} onBack={onBack} onSignOut={onSignOut} />
        ) : (
          signInComponent
        )}
      </MantineContainer>
    </MyoxusOtherPageLayout>
  );
}

export function NotFoundPage({ user, onBack, onSignOut }: NotFoundPageProps) {
  return (
    <MyoxusOtherPageLayout>
      <AuthBackgroundArt />
      <MantineContainer
        component="main"
        py="xl"
        pos="relative"
        size={620}
        style={{ zIndex: 1 }}
        data-testid="not-found"
        data-myoxus-error-status="404"
        data-myoxus-ui-role="empty-state-panel"
      >
        <NotFoundContent user={user} onBack={onBack} onSignOut={onSignOut} />
      </MantineContainer>
    </MyoxusOtherPageLayout>
  );
}
