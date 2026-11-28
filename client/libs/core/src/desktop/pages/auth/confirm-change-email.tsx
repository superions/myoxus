// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { GraphQLService } from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import { changeEmailMutation } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { AuthPageContainer, Button } from "@myoxus/ui-facade";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { AppContainer } from "../../components/app-container";

export function ConfirmChangeEmail({
  onOpenMyoxus,
}: {
  onOpenMyoxus: () => void;
}) {
  const t = useI18n();
  const [searchParams] = useSearchParams();
  const navigateHelper = useNavigateHelper();
  const graphqlService = useService(GraphQLService);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = searchParams.get("token") ?? "";
    const email = decodeURIComponent(searchParams.get("email") ?? "");
    setLoading(true);
    graphqlService
      .gql({
        query: changeEmailMutation,
        variables: { token, email },
      })
      .catch((error) => {
        if (UserFriendlyError.fromAny(error).is("INVALID_EMAIL_TOKEN")) {
          navigateHelper.jumpToExpired();
          return;
        }
        console.error(error);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [graphqlService, navigateHelper, searchParams]);

  if (loading) {
    return <AppContainer fallback />;
  }

  return (
    <AuthPageContainer
      title={t["com.myoxus.auth.change.email.page.success.title"]()}
      subtitle={t["com.myoxus.auth.change.email.page.success.subtitle"]()}
    >
      <Button variant="primary" size="large" onClick={onOpenMyoxus}>
        {t["com.myoxus.auth.open.myoxus"]()}
      </Button>
    </AuthPageContainer>
  );
}
