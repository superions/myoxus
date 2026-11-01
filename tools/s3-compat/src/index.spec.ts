import { describe, expect, it } from "vitest";

import { parseListPartsXml } from "./index.js";

describe("S3 control XML boundary", () => {
  it("does not expand document entities", () => {
    const xml = `<!DOCTYPE x [
      <!ENTITY a "1234567890">
      <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
    ]>
    <ListPartsResult>
      <Part><PartNumber>&b;</PartNumber><ETag>unsafe</ETag></Part>
    </ListPartsResult>`;

    expect(parseListPartsXml(xml)).toEqual({
      isTruncated: false,
      nextPartNumberMarker: undefined,
      parts: [],
    });
  });

  it("keeps comments and CDATA inside their XML boundaries", () => {
    const xml = `
      <ListPartsResult>
        <!-- <Part><PartNumber>1</PartNumber><ETag>comment</ETag></Part> -->
        <Part><PartNumber>2</PartNumber><ETag><![CDATA["safe-etag"]]></ETag></Part>
        <IsTruncated>false</IsTruncated>
      </ListPartsResult>`;

    expect(parseListPartsXml(xml)).toEqual({
      isTruncated: false,
      nextPartNumberMarker: undefined,
      parts: [{ etag: "safe-etag", partNumber: 2 }],
    });
  });

  it("decodes only built-in XML references", () => {
    const xml = `<s3:ListPartsResult xmlns:s3="urn:s3">
      <s3:Part><s3:PartNumber>7</s3:PartNumber><s3:ETag>&quot;safe&amp;etag&quot;</s3:ETag></s3:Part>
      <s3:IsTruncated>true</s3:IsTruncated>
      <s3:NextPartNumberMarker>7</s3:NextPartNumberMarker>
    </s3:ListPartsResult>`;

    expect(parseListPartsXml(xml)).toEqual({
      isTruncated: true,
      nextPartNumberMarker: "7",
      parts: [{ etag: "safe&etag", partNumber: 7 }],
    });
  });

  it("rejects control responses above the bounded protocol size", () => {
    const oversized = `<ListPartsResult>${" ".repeat(8 * 1024 * 1024)}</ListPartsResult>`;

    expect(() => parseListPartsXml(oversized)).toThrow(
      "S3 control XML exceeds the 8 MiB protocol limit",
    );
  });
});
