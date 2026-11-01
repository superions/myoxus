import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { GraphQLService } from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import { verifyEmailMutation } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { AuthPageContainer, Button } from "@myoxus/ui-facade";
import { type FC, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { AppContainer } from "../../components/app-container";

export const ConfirmVerifiedEmail: FC<{
  onOpenMyoxus: () => void;
}> = ({ onOpenMyoxus }) => {
  const t = useI18n();
  const graphqlService = useService(GraphQLService);
  const [isLoading, setIsLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const navigateHelper = useNavigateHelper();

  useEffect(() => {
    (async () => {
      const token = searchParams.get("token") ?? "";
      setIsLoading(true);
      await graphqlService
        .gql({
          query: verifyEmailMutation,
          variables: {
            token: token,
          },
        })
        .catch((error) => {
          const userFriendlyError = UserFriendlyError.fromAny(error);
          if (userFriendlyError.is("INVALID_EMAIL_TOKEN")) {
            return navigateHelper.jumpToExpired();
          }
          throw error;
        });
    })().catch((err) => {
      // TODO(@eyhn): Add error handling
      console.error(err);
    });
  }, [graphqlService, navigateHelper, searchParams]);

  if (isLoading) {
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
};
