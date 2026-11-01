import { type LiveData, Service } from "@myoxus/infra";

import type { DocService } from "../../doc";
import { INTEGRATION_PROPERTY_SCHEMA } from "../constant";
import type { IntegrationDocPropertiesMap, IntegrationType } from "../type";

export class IntegrationPropertyService extends Service {
  constructor(private readonly docService: DocService) {
    super();
  }

  integrationType$ = this.docService.doc.integrationType$;

  schema$ = this.integrationType$.map((type) =>
    type ? INTEGRATION_PROPERTY_SCHEMA[type] : null,
  );

  integrationProperty$(
    type: IntegrationType,
    key: string,
  ): LiveData<Record<string, any> | undefined | null>;
  integrationProperty$<
    T extends IntegrationType,
    Key extends keyof IntegrationDocPropertiesMap[T],
  >(type: T, key: Key) {
    return this.docService.doc.properties$.selector(
      (p) => p[`${type}:${key.toString()}`],
    ) as LiveData<IntegrationDocPropertiesMap[T][Key] | undefined | null>;
  }

  updateIntegrationProperties<T extends IntegrationType>(
    type: T,
    updates: Partial<IntegrationDocPropertiesMap[T]>,
  ) {
    void this.docService.doc
      .setIntegrationType(type)
      .then(() => {
        this.docService.doc.updateProperties(
          Object.fromEntries(
            Object.entries(updates).map(([key, value]) => {
              return [`${type}:${key.toString()}`, value];
            }),
          ),
        );
      })
      .catch((error) => {
        console.error("[integration] native integrationType write failed", {
          docId: this.docService.doc.id,
          type,
          error,
        });
      });
  }
}
