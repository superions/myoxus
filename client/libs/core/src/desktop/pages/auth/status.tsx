// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AuthContainer,
  AuthContent,
  AuthHeader,
  AuthPanelFrame,
  AuthProgressRow,
  MyoxusOtherPageLayout,
  SignInPageContainer,
} from "@myoxus/ui-facade";

import { SignInBackgroundArts } from "../../../components/sign-in/background-arts";

export function AuthStatusPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <MyoxusOtherPageLayout>
      <SignInBackgroundArts />
      <SignInPageContainer>
        <AuthPanelFrame>
          <AuthContainer>
            <AuthHeader title={title} />
            <AuthContent>
              <AuthProgressRow>{description}</AuthProgressRow>
            </AuthContent>
          </AuthContainer>
        </AuthPanelFrame>
      </SignInPageContainer>
    </MyoxusOtherPageLayout>
  );
}
