import { UserFriendlyError } from "@myoxus/error";
import { I18n } from "@myoxus/i18n";
import { Service } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";

import type { DocsService } from "../../doc";
import type { WorkbenchService } from "../../workbench";
import { CollectionsQuickSearchSession } from "../impls/collections";
import { CommandsQuickSearchSession } from "../impls/commands";
import { CreationQuickSearchSession } from "../impls/creation";
import { DatabaseRowsQuickSearchSession } from "../impls/database-rows";
import { DatabasesQuickSearchSession } from "../impls/databases";
import { DocsQuickSearchSession } from "../impls/docs";
import { FavoritesQuickSearchSession } from "../impls/favorites";
import { RecentTargetsQuickSearchSession } from "../impls/recent-targets";
import { TagsQuickSearchSession } from "../impls/tags";
import type { QuickSearchService } from "./quick-search";

export class CMDKQuickSearchService extends Service {
  constructor(
    private readonly quickSearchService: QuickSearchService,
    private readonly workbenchService: WorkbenchService,
    private readonly docsService: DocsService,
  ) {
    super();
  }

  toggle() {
    if (this.quickSearchService.quickSearch.show$.value) {
      this.quickSearchService.quickSearch.hide();
    } else {
      this.quickSearchService.quickSearch.show(
        [
          this.framework.createEntity(CommandsQuickSearchSession),
          this.framework.createEntity(RecentTargetsQuickSearchSession),
          this.framework.createEntity(FavoritesQuickSearchSession),
          this.framework.createEntity(CreationQuickSearchSession),
          this.framework.createEntity(DocsQuickSearchSession),
          this.framework.createEntity(DatabasesQuickSearchSession),
          this.framework.createEntity(DatabaseRowsQuickSearchSession),
          this.framework.createEntity(CollectionsQuickSearchSession),
          this.framework.createEntity(TagsQuickSearchSession),
        ],
        (result) => {
          if (!result) {
            return;
          }

          if (result.source === "commands") {
            void Promise.resolve()
              .then(() => result.payload.run())
              .catch((error) => {
                const friendly = UserFriendlyError.fromAny(error);
                notify.error({
                  title: I18n.t("com.myoxus.common.operation-failed"),
                  message: friendly.message,
                });
              });
            return;
          }

          if (result.source === "recent-target") {
            if (result.payload.type === "doc") {
              this.workbenchService.workbench.openDoc(result.payload.docId);
            } else {
              this.workbenchService.workbench.open(result.payload.route, {
                at: "active",
              });
            }
            return;
          }

          if (result.source === "favorites") {
            if (result.payload.type === "doc") {
              this.workbenchService.workbench.openDoc(result.payload.docId);
            } else if (result.payload.type === "collection") {
              this.workbenchService.workbench.openCollection(
                result.payload.collectionId,
              );
            } else if (result.payload.type === "tag") {
              this.workbenchService.workbench.openTag(result.payload.tagId);
            } else {
              this.workbenchService.workbench.open(result.payload.route, {
                at: "active",
              });
            }
            return;
          }

          if (result.source === "docs") {
            const doc: {
              docId?: string;
              blockId?: string;
            } = result.payload;

            if (!doc.docId) {
              return;
            }

            track.$.cmdk.results.searchResultsDocs();

            const options: { docId: string; blockIds?: string[] } = {
              docId: doc.docId,
            };

            if (doc.blockId) {
              options.blockIds = [doc.blockId];
            }

            this.workbenchService.workbench.openDoc(options);
            return;
          }

          if (
            result.source === "databases" ||
            result.source === "database-rows"
          ) {
            this.workbenchService.workbench.open(result.payload.route, {
              at: "active",
            });
            return;
          }

          if (result.source === "collections") {
            this.workbenchService.workbench.openCollection(
              result.payload.collectionId,
            );
            return;
          }

          if (result.source === "tags") {
            this.workbenchService.workbench.openTag(result.payload.tagId);
            return;
          }

          if (result.source === "creation") {
            const mode =
              result.id === "creation:create-page"
                ? "page"
                : result.id === "creation:create-edgeless"
                  ? "edgeless"
                  : null;
            if (mode) {
              const newDoc = this.docsService.createDoc({
                primaryMode: mode,
                title: result.payload.title,
              });
              this.workbenchService.workbench.openDoc({
                docId: newDoc.id,
                mode,
              });
            }
            return;
          }
        },
        {
          placeholder: {
            i18nKey: "com.myoxus.cmdk.placeholder",
          },
        },
      );
    }
  }
}
