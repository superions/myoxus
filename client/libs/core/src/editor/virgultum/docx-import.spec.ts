import { HtmlTransformer } from "@virgultum/editor/widgets/linked-doc";
/** @vitest-environment happy-dom */
import { StoreExtensionManager } from "@virgultum/editor/ext-loader";
import { getInternalStoreExtensions } from "@virgultum/editor/extensions/store";
import type {
  ImageBlockModel,
  ListBlockModel,
  ParagraphBlockModel,
  TableBlockModel,
} from "@virgultum/model";
import { Schema } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import JSZip from "jszip";
import { convertToHtml } from "mammoth";
import { afterEach, beforeEach, expect, test } from "vitest";

import { MyoxusSchemas } from "@virgultum/editor/schemas";

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>DOCX fidelity</w:t></w:r></w:p>
    <w:p><w:r><w:t>Escaped &amp; exact &lt;text&gt;</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second item</w:t></w:r></w:p>
    <w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>External link</w:t></w:r></w:hyperlink></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Pixel" descr="Import pixel"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

async function createDocx(xml = documentXml) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  );
  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/docx" TargetMode="External"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pixel.png"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
  );
  zip.file("word/document.xml", xml);
  zip.file(
    "word/media/pixel.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const archive = await zip.generateAsync({ type: "arraybuffer" });
  return new Blob([archive]);
}

const schema = new Schema().register(MyoxusSchemas);
const testStoreExtensions = new StoreExtensionManager(
  getInternalStoreExtensions(),
).get("store");
let collection: TestWorkspace;

beforeEach(() => {
  collection = new TestWorkspace();
  collection.storeExtensions = testStoreExtensions;
  collection.meta.initialize();
});

afterEach(() => {
  collection.forceStop();
  collection.dispose();
});

test("DOCX conversion and HTML import preserve structured content and embedded assets", async () => {
  const imported = await createDocx();
  const { value } = await convertToHtml({
    buffer: Buffer.from(await imported.arrayBuffer()),
  });
  expect(value).toContain("<h2>DOCX fidelity</h2>");
  const docId = await HtmlTransformer.importHTMLToDoc({
    collection,
    schema,
    html: value,
    extensions: testStoreExtensions,
  });

  expect(docId).toMatch(/^\S+$/);
  const store = collection.getDoc(docId!)!.getStore({
    extensions: testStoreExtensions,
  });
  const paragraphs = store
    .getBlocksByFlavour("myoxus:paragraph")
    .map((block) => block.model as ParagraphBlockModel);
  expect(paragraphs.map((block) => block.props.text.toString())).toEqual(
    expect.arrayContaining(["Escaped & exact <text>", "External link"]),
  );
  expect(
    paragraphs
      .find((block) => block.props.text.toString() === "External link")!
      .props.text.toDelta(),
  ).toEqual([
    expect.objectContaining({
      insert: "External link",
      attributes: expect.objectContaining({
        link: "https://example.test/docx",
      }),
    }),
  ]);
  expect(
    store
      .getBlocksByFlavour("myoxus:list")
      .map((block) => (block.model as ListBlockModel).props.text.toString()),
  ).toEqual(["First item", "Second item"]);
  const tables = store.getBlocksByFlavour("myoxus:table");
  expect(tables).toHaveLength(1);
  expect(
    Object.values((tables[0].model as TableBlockModel).props.cells).map(
      (cell) => cell.text.toString(),
    ),
  ).toEqual(["Cell A", "Cell B"]);

  const images = store.getBlocksByFlavour("myoxus:image");
  expect(images).toHaveLength(1);
  const sourceId = (images[0].model as ImageBlockModel).props.sourceId;
  expect(sourceId).toMatch(/^\S+$/);
  expect(await collection.blobSync.get(sourceId!)).not.toBeNull();
});

test("DOCX import rejects malformed XML without creating a partial document", async () => {
  const imported = await createDocx(
    documentXml.replace("</w:t>", "</w:t\n injected>"),
  );
  await expect(
    convertToHtml({
      buffer: Buffer.from(await imported.arrayBuffer()),
    }),
  ).rejects.toThrow();

  expect(collection.docs.size).toBe(0);
});
