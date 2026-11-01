# Editor Typography Stress Document

This document is a dense manual-test seed for typography, long-flow rendering,
selection behavior, previews, search extraction, and export smoke checks. It
intentionally contains many heading levels, repeated small headings, formatted
runs, lists, tables, code blocks, SVG images, and PNG images.

## Purpose

The document should make visual regressions obvious in document lists, editor
surfaces, metadata panels, search results, and export paths. It is not product
documentation; it is a stable local-dev fixture.

### Formatting Matrix

Text must preserve **bold emphasis**, _italic emphasis_, **_combined emphasis_**,
`inline code`, ~~strikethrough text~~, and links such as
[Myoxus local web](http://localhost:3010). A long sentence follows so wrapping
can be inspected across several viewport widths without relying on artificial
line breaks in the source document.

#### H4 Probe 01 - Dense Paragraph

The first small-heading section contains a long paragraph with **bold labels**,
_italic qualifiers_, and `inline tokens`. It should wrap cleanly and maintain
consistent line height in both preview cards and the full editor.

##### H5 Probe 01 - Nested Detail

- Bullet item with a short lead.
- Bullet item with **bold** and _italic_ fragments.
- Bullet item with `inline code` and a trailing sentence for wrapping.

###### H6 Probe 01 - Leaf Note

1. Numbered step one with a concise instruction.
2. Numbered step two with a nested idea expressed in normal text.
3. Numbered step three with `code-like` content.

#### H4 Probe 02 - Ordered Flow

1. Open the workspace.
2. Select this seed document.
3. Switch between list, card, and compact views.
4. Confirm that the document title, preview, and action menu remain readable.

##### H5 Probe 02 - Checklist

- [x] Heading levels are present.
- [x] Lists are present.
- [x] Tables are present.
- [x] Images are present.
- [ ] Visual review still needs a human eye.

###### H6 Probe 02 - Tiny Section

Small headings should not collapse into body copy or pick up inconsistent
weights from local CSS.

#### H4 Probe 03 - Blockquote

> This blockquote should keep a clear rhythm, readable contrast, and enough
> spacing from surrounding content without becoming a decorative card.

##### H5 Probe 03 - Inline Runs

The phrase **important bold phrase** is followed by _careful italic context_ and
then by `stable_identifier_for_tests`. A mixed line with **_all emphasis_** helps
catch overly aggressive Markdown normalization.

###### H6 Probe 03 - Table Lead

The table below checks header, body, alignment, and wrapping behavior.

| Column     | Expected Behavior                         | Stress Value          |
| ---------- | ----------------------------------------- | --------------------- |
| Headings   | Level-specific hierarchy remains visible  | H1 through H6         |
| Lists      | Bullets and numbers keep indentation      | Nested enough to read |
| Formatting | Bold, italic, code, strike survive import | Mixed inline runs     |
| Images     | SVG and PNG URLs remain represented       | Data URI sources      |

#### H4 Probe 04 - SVG Image

![SVG layout probe](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='360'%20height='120'%20viewBox='0%200%20360%20120'%3E%3Crect%20width='360'%20height='120'%20rx='14'%20fill='%23f8fafc'/%3E%3Ccircle%20cx='64'%20cy='60'%20r='34'%20fill='%232563eb'/%3E%3Crect%20x='122'%20y='32'%20width='188'%20height='18'%20rx='9'%20fill='%23111827'/%3E%3Crect%20x='122'%20y='62'%20width='138'%20height='14'%20rx='7'%20fill='%2364748b'/%3E%3Ctext%20x='42'%20y='68'%20font-size='22'%20font-family='Arial'%20fill='white'%3ESVG%3C/text%3E%3C/svg%3E)

##### H5 Probe 04 - PNG Image

![PNG baseline probe](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)

###### H6 Probe 04 - Image Notes

The SVG is intentionally visible, while the PNG is intentionally tiny and stable
so URL handling and image serialization can be tested without large binary
fixtures.

#### H4 Probe 05 - Code Fence

```ts
type RenderProbe = {
  id: string;
  title: string;
  headings: Array<"h1" | "h2" | "h3" | "h4" | "h5" | "h6">;
  hasTables: boolean;
  hasImages: boolean;
};

export function describeProbe(probe: RenderProbe): string {
  return `${probe.title}: ${probe.headings.length} heading levels`;
}
```

##### H5 Probe 05 - Numbered Subflow

1. Parse Markdown.
2. Create a Yjs document.
3. Register the page in the workspace root document.
4. Render through the normal web frontend.

###### H6 Probe 05 - Expected Result

Nothing in this section should require product-specific CSS to look acceptable.

#### H4 Probe 06 - Long Content A

Long content block A gives document previews and scroll containers enough text
to truncate. The paragraph deliberately repeats meaningful words: typography,
spacing, hierarchy, alignment, preview, export, search, sidebar, editor, and
document card.

##### H5 Probe 06 - Long Content B

Long content block B adds more body text after a small heading. It should remain
clear that H5 is subordinate to H4 and still stronger than ordinary paragraph
text, even after import.

###### H6 Probe 06 - Long Content C

Long content block C is intentionally small but visible. It should not be styled
as a button, badge, card title, caption, or metadata label.

#### H4 Probe 07 - Nested List

- Workspace
  - Root document
  - Seeded manual-test documents
  - Search index entries
- Document
  - Title
  - Body blocks
  - Root-doc registration

##### H5 Probe 07 - Numbered Nested List

1. First group
   1. First nested step
   2. Second nested step
2. Second group
   1. First nested step
   2. Second nested step

###### H6 Probe 07 - List Notes

Nested indentation should be readable even if the converter flattens advanced
Markdown structures differently from the editor's native block model.

#### H4 Probe 08 - Wide Table

| Area    | Desktop Signal     | Compact Signal         | Failure Mode        | Review Note               |
| ------- | ------------------ | ---------------------- | ------------------- | ------------------------- |
| Header  | Title centered     | Controls remain usable | Tiny icons          | Check view switchers      |
| Sidebar | Sections separated | Text readable          | Overpacked nav      | Check workspace list      |
| Cards   | Preview visible    | Actions reachable      | Empty-looking cards | Check image/text fallback |
| Modal   | Full width used    | Content wraps          | Collapsed form      | Check metadata panel      |

##### H5 Probe 08 - Table Follow-Up

Tables should not force the document canvas to become unreadable. If overflow is
needed, it should be deliberate and easy to inspect.

###### H6 Probe 08 - Table Leaf

The table includes enough columns to reveal cramped layout decisions.

#### H4 Probe 09 - Horizontal Separator

---

##### H5 Probe 09 - After Separator

Text after a separator should preserve normal vertical rhythm.

###### H6 Probe 09 - Final Small Heading Pair

This is the ninth H6 probe in the typography fixture.

#### H4 Probe 10 - Closing Section

The tenth H4 section ensures smaller heading repetition is present in a single
document, not only across the fixture set.

##### H5 Probe 10 - Closing Detail

The tenth H5 section closes the heading-density test.

###### H6 Probe 10 - Closing Leaf

The tenth H6 section closes the smallest-heading test.

## Closing Summary

This seed document is intentionally long enough to produce multi-screen reading
in the editor. It should remain useful when testing previews, export, search,
typography tokens, and Mantine/Facade visual cleanup.
