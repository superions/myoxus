import { NoPageRootError } from "@myoxus/core/editor/virgultum/doc-editor/no-page-error";
import { useI18n } from "@myoxus/i18n";

import { ContactUS, ErrorDetail } from "../error-basic/error-detail";
import { createErrorFallback } from "../error-basic/fallback-creator";

export const NoPageRootFallback = createErrorFallback(
  NoPageRootError,
  (props) => {
    const { resetError } = props;
    const t = useI18n();

    return (
      <ErrorDetail
        title={t["com.myoxus.error.no-page-root.title"]()}
        description={<ContactUS />}
        resetError={resetError}
      />
    );
  },
);
