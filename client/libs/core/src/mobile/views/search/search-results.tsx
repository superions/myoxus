import { useI18n } from "@myoxus/i18n";
import {
  MobileDocStripItem,
  MobileSearchDocScroller,
  MobileSearchDocStrip,
  MobileSearchEmpty,
  MobileSearchError,
  MobileSearchList,
  MobileSearchResultsTitle,
  MobileSearchSection,
  MobileSearchSectionTitle,
} from "@myoxus/ui-facade";

import { DocCard, type DocCardProps } from "../../components";
import {
  UniversalSearchResultItem,
  type UniversalSearchResultItemProps,
} from "../../components/search-result/universal-item";

export interface SearchResultsProps {
  title: string;
  docs?: DocCardProps["meta"][];
  collections?: UniversalSearchResultItemProps["item"][];
  tags?: UniversalSearchResultItemProps["item"][];
  error?: any;
}

const Empty = () => {
  const t = useI18n();
  return (
    <MobileSearchEmpty>
      {t["com.myoxus.mobile.search.empty"]()}
    </MobileSearchEmpty>
  );
};

export const SearchResults = ({
  title,
  docs,
  collections,
  tags,
  error,
}: SearchResultsProps) => {
  return (
    <>
      <MobileSearchResultsTitle>{title}</MobileSearchResultsTitle>

      {error ? <MobileSearchError>{error}</MobileSearchError> : null}

      {!docs?.length && !collections?.length && !tags?.length ? (
        <Empty />
      ) : null}

      {/* Doc Res */}
      {docs?.length ? (
        <MobileSearchSection horizontal>
          <MobileSearchSectionTitle>Docs</MobileSearchSectionTitle>
          <MobileSearchDocScroller>
            <MobileSearchDocStrip>
              {docs.map((doc) => (
                <MobileDocStripItem key={doc.id}>
                  <DocCard meta={doc} />
                </MobileDocStripItem>
              ))}
            </MobileSearchDocStrip>
          </MobileSearchDocScroller>
        </MobileSearchSection>
      ) : null}

      {/* Collection Res */}
      {collections?.length ? (
        <MobileSearchSection>
          <MobileSearchSectionTitle>Collections</MobileSearchSectionTitle>
          <MobileSearchList>
            {collections.map((collection) => (
              <UniversalSearchResultItem
                category="collection"
                id={collection.payload.collectionId}
                key={collection.id}
                item={collection}
              />
            ))}
          </MobileSearchList>
        </MobileSearchSection>
      ) : null}

      {/* Tag Res */}
      {tags?.length ? (
        <MobileSearchSection>
          <MobileSearchSectionTitle>Tags</MobileSearchSectionTitle>
          <MobileSearchList>
            {tags.map((tag) => (
              <UniversalSearchResultItem
                category="tag"
                id={tag.payload.tagId}
                key={tag.id}
                item={tag}
              />
            ))}
          </MobileSearchList>
        </MobileSearchSection>
      ) : null}
    </>
  );
};
