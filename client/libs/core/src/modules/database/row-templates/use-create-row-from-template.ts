// SPDX-License-Identifier: AGPL-3.0-or-later

import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import {
  createDatabaseRowFromTemplateMutation,
  databaseRowTemplateBodyInputsQuery,
  type QueryVariables,
  type RecursiveMaybeFields,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TemplateInputPromptService } from "../../template-doc/services/template-input-prompt";
import { TemplateInstantiationError } from "../../template-doc/services/template-instantiation-error";
import { normalizeTemplateInputs } from "../../template-doc/services/template-inputs";

export type CreateRowFromTemplateVariables = QueryVariables<
  typeof createDatabaseRowFromTemplateMutation
>;

/** Capture and prompt before the write. The server rechecks source identity,
 * authorization and revision; no client-computed facts cross that boundary. */
export function useCreateRowFromTemplate(
  workspaceId: string,
  transport?: Pick<GraphQLService, "gql">,
  callerOwnsError = false,
) {
  const graphql = useService(GraphQLService);
  const framework = useFramework();
  const t = useI18n();
  const server = transport ?? graphql;
  const busy = useRef<AbortSignal | null>(null);
  const [isMutating, setPending] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!isMutating && restoreFocus) {
      if (restoreFocus.isConnected) restoreFocus.focus();
      setRestoreFocus(null);
    }
  }, [isMutating, restoreFocus]);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    busy.current = null;
    setPending(false);
    return () => controller.abort(new TemplateInstantiationError("cancelled"));
  }, [workspaceId, server]);
  const trigger = useCallback(
    async ({ input }: CreateRowFromTemplateVariables) => {
      if (busy.current) return;
      const owner = lifetime.current.signal;
      const invokingControl =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      busy.current = owner;
      setPending(true);
      try {
        const prompts = framework.get(TemplateInputPromptService);
        return await prompts.run(
          async (request, signal) => {
            const captured = await server.gql({
              query: databaseRowTemplateBodyInputsQuery,
              variables: {
                workspaceId,
                databaseId: input.databaseId,
                rowTemplateId: input.rowTemplateId,
              },
            });
            owner.throwIfAborted();
            signal.throwIfAborted();
            const body = captured.workspace?.databaseRowTemplateBodyInputs;
            if (!body) throw new Error("Row template unavailable");
            const answers = await request(
              body.requiredInputs,
              AbortSignal.any([signal, owner]),
            );
            owner.throwIfAborted();
            signal.throwIfAborted();
            // Preserve the existing mutation input types. Generated Date scalars
            // are unknown; the fetcher’s recursive nullable helper narrows them.
            return server.gql({
              query: createDatabaseRowFromTemplateMutation,
              variables: {
                input: {
                  ...input,
                  ...(body.requiredInputs.length
                    ? {
                        bodyInputs: normalizeTemplateInputs(
                          body.requiredInputs,
                          answers,
                        ),
                      }
                    : {}),
                  ...(body.sourceRevision
                    ? { sourceRevision: body.sourceRevision }
                    : {}),
                },
              } as RecursiveMaybeFields<CreateRowFromTemplateVariables>,
            });
          },
          {
            signal: owner,
            propagateError: (error) => {
              const diagnostic = error as {
                extensions?: { code?: unknown; data?: { code?: unknown } };
              };
              const code =
                diagnostic?.extensions?.code ??
                diagnostic?.extensions?.data?.code;
              return [
                "MIX_DATABASE_TASK_RELATION_INVALID",
                "MIX_DATABASE_CELL_VALUE_INVALID",
                "MIX_DATABASE_FIELD_REQUIRED",
              ].includes(String(code));
            },
            // These codes originate before create_row_with_kind. Other errors may
            // follow a committed Row and require explicit readback by the consumer.
            canRetry: (error) => {
              const diagnostic = error as {
                extensions?: { code?: string; data?: { code?: string } };
              };
              const code =
                diagnostic?.extensions?.code ??
                diagnostic?.extensions?.data?.code;
              return [
                "MIX_DATABASE_ROW_TEMPLATE_TEMPLATE_INVALID",
                "MIX_DATABASE_ROW_TEMPLATE_FORBIDDEN",
                "MIX_DATABASE_ROW_TEMPLATE_NOT_FOUND",
                "MIX_DATABASE_ROW_TEMPLATE_RECONCILE_REQUIRED",
              ].includes(String(code));
            },
            uncertainMessage:
              t["com.myoxus.template-input.error.write-unconfirmed"](),
          },
        );
      } catch (error) {
        if (
          error instanceof TemplateInstantiationError &&
          error.reason === "cancelled"
        ) {
          if (!owner.aborted) setRestoreFocus(invokingControl);
          return;
        }
        if (callerOwnsError) throw error;
        notify.error({
          title: t["com.myoxus.template-application.error.failed"](),
        });
        return;
      } finally {
        if (busy.current === owner) {
          busy.current = null;
          if (!owner.aborted) setPending(false);
        }
      }
    },
    [workspaceId, server, framework, t, callerOwnsError],
  );
  return useMemo(() => ({ trigger, isMutating }), [trigger, isMutating]);
}
