import { CollectionService } from "@myoxus/core/modules/collection";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { useLiveData, useServices } from "@myoxus/infra";
import { useThemeColor } from "@myoxus/ui-facade";
import { useEffect } from "react";
import { useParams } from "react-router";

import { CollectionDetail } from "../../../views";

export const Component = () => {
  useThemeColor("backgroundSecondaryColor");
  const { collectionService, globalContextService } = useServices({
    CollectionService,
    GlobalContextService,
  });

  const globalContext = globalContextService.globalContext;
  const params = useParams();
  const collection = useLiveData(
    params.collectionId
      ? collectionService.collection$(params.collectionId)
      : null,
  );

  useEffect(() => {
    if (collection) {
      globalContext.collectionId.set(collection.id);
      globalContext.isCollection.set(true);

      return () => {
        globalContext.collectionId.set(null);
        globalContext.isCollection.set(false);
      };
    }
    return;
  }, [collection, globalContext]);

  if (!collection) {
    // TODO: implement 404 page
    return <div></div>;
  }

  return <CollectionDetail collection={collection} />;
};
