import { describe, expect, it } from "vitest";

import {
  deleteDocumentPermanentlyMutation,
  deleteDocumentsPermanentlyMutation,
  emptyWorkspaceTrashMutation,
} from "../graphql";

const REQUIRED_PAYLOAD_FIELDS = [
  "requested",
  "deleted",
  "notFound",
  "forbidden",
  "alreadyDeleted",
  "notTrashed",
  "failed",
  "rootMetaRemoved",
  "clientDocId",
  "resolvedDocId",
  "status",
  "reason",
];

describe("document permanent-delete mutations", () => {
  it("exports the single-document mutation with the structured result payload", () => {
    expect(deleteDocumentPermanentlyMutation).toMatchObject({
      id: "deleteDocumentPermanentlyMutation",
      op: "deleteDocumentPermanently",
    });
    expect(deleteDocumentPermanentlyMutation.query).toContain(
      "mutation deleteDocumentPermanently",
    );
    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      expect(deleteDocumentPermanentlyMutation.query).toContain(field);
    }
  });

  it("exports the bulk mutation with the same structured result payload", () => {
    expect(deleteDocumentsPermanentlyMutation).toMatchObject({
      id: "deleteDocumentsPermanentlyMutation",
      op: "deleteDocumentsPermanently",
    });
    expect(deleteDocumentsPermanentlyMutation.query).toContain(
      "mutation deleteDocumentsPermanently",
    );
    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      expect(deleteDocumentsPermanentlyMutation.query).toContain(field);
    }
  });

  it("exports emptyWorkspaceTrash as a mutation, not a local storage helper", () => {
    expect(emptyWorkspaceTrashMutation).toMatchObject({
      id: "emptyWorkspaceTrashMutation",
      op: "emptyWorkspaceTrash",
    });
    expect(emptyWorkspaceTrashMutation.query).toContain(
      "mutation emptyWorkspaceTrash",
    );
    for (const field of REQUIRED_PAYLOAD_FIELDS) {
      expect(emptyWorkspaceTrashMutation.query).toContain(field);
    }
  });
});
