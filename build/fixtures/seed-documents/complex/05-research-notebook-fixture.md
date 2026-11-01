# Compact Research Smoke Fixture

This deliberately short fixture checks that compact documents still exercise the
same rendering paths as larger seeds. It should fit into a quick visual review
while still containing headings, lists, tables, media, code, and inline marks.

## Research Question

Can a short document remain useful for editor, preview, search, and sidebar
testing without looking like a placeholder?

### Hypothesis

If the document has clear structure and a little variety, then short-card
previews and search snippets become easier to judge. This sentence includes
**bold evidence**, _italic nuance_, and `inline_code_token`.

#### Method

- Open the seeded workspace.
- Search for `compact-research-smoke`.
- Compare list view and card view.
- Confirm the document does not look empty.

##### Steps

1. Seed the local dataset.
2. Open this page.
3. Switch document-list views.
4. Inspect the action menu and preview.

###### Expected Signal

Short documents should remain visually complete and should not need fake filler
content to make the UI usable.

## Tiny Data Table

| Area    | Signal               | Risk                |
| ------- | -------------------- | ------------------- |
| Preview | Short but meaningful | Blank card          |
| Search  | Distinct marker      | Missing index       |
| Editor  | Stable hierarchy     | Overstyled headings |

## Media

![Compact SVG marker](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='280'%20height='96'%20viewBox='0%200%20280%2096'%3E%3Crect%20width='280'%20height='96'%20rx='14'%20fill='%23eef2ff'/%3E%3Ccircle%20cx='56'%20cy='48'%20r='26'%20fill='%234f46e5'/%3E%3Crect%20x='104'%20y='30'%20width='128'%20height='12'%20rx='6'%20fill='%231e293b'/%3E%3Crect%20x='104'%20y='54'%20width='92'%20height='10'%20rx='5'%20fill='%2364748b'/%3E%3C/svg%3E)

![Compact PNG marker](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)

## Code

```ts
export const compactResearchSmoke = {
  marker: "compact-research-smoke",
  expectedLength: "short",
  stillComplex: true,
};
```

## Closing Note

This fixture is intentionally much shorter than the others. It exists so local
visual QA includes a realistic small document instead of only long reports.
