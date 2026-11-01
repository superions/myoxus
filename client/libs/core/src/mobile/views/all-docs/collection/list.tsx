import { EmptyCollections } from "@myoxus/core/components/myoxus/empty";
import { CollectionService } from "@myoxus/core/modules/collection";
import { useLiveData, useService } from "@myoxus/infra";
import { SurfaceList } from "@myoxus/ui-facade";

import { CollectionListItem } from "./item";

export const CollectionList = () => {
  const collectionService = useService(CollectionService);
  const collectionMetas = useLiveData(collectionService.collectionMetas$);

  if (!collectionMetas.length) {
    return <EmptyCollections absoluteCenter />;
  }

  return (
    <SurfaceList label="Collections">
      {collectionMetas.map((meta) => (
        <CollectionListItem key={meta.id} meta={meta} />
      ))}
    </SurfaceList>
  );
};
