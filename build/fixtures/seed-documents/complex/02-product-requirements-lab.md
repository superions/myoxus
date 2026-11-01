# Long Text Requirements Fixture

This fixture is intentionally the long, text-heavy member of the local seed
set. It should take several screens to read, create meaningful search snippets,
exercise preview truncation, and reveal whether typography, line height, and
editor rhythm remain comfortable when the document is mostly prose.

## Executive Summary

The fictional product area described here is a workspace review workflow. The
details are not product commitments. They are stable test prose with realistic
shape: motivation, requirements, constraints, risks, acceptance criteria,
decision notes, and implementation guidance. The text includes **bold decision
labels**, _italic caveats_, `technical_identifiers`, tables, numbered lists,
unordered lists, code blocks, SVG, and PNG media. The goal is to ensure long
documents feel intentional rather than padded.

### Target Outcome

Local development workspaces need documents that are long enough to stress the
interface without requiring a developer to manufacture data in the browser.
This fixture provides that pressure. It should be useful in all document-list
views, in the full editor, in search, in export flows, and in any future
metadata or document-info panels that show excerpts.

#### Reader Profile

The reader is a developer or reviewer validating the interface. They want to
know whether the document is easy to scan, whether headings remain predictable,
whether dense paragraphs wrap cleanly, and whether action controls stay usable
when the surrounding content is not visually simple.

##### Review Principle

Good long-form rendering should not depend on local route-specific CSS. It
should come from the shared typography and editor rendering contracts.

###### Leaf Signal

This H6 line confirms the long text fixture participates in smallest-heading
tests without becoming a fake outline-only page.

## Problem Statement

Many user interfaces look acceptable with short fixture text and then degrade
when the content becomes realistic. Titles wrap into controls, previews extract
unhelpful fragments, tables create awkward gaps, and long paragraphs expose
inconsistent line heights. A text-heavy seed document helps catch these
regressions early.

The document also helps test search and indexing. A short document can confirm
that indexing works at all, but it cannot show whether a search result selects a
useful snippet from a long body. This fixture repeats distinctive terms in
natural prose: workspace review, requirement narrative, typography review,
search snippet, preview truncation, and long document rhythm.

### Background

Local test datasets already create users and workspaces. Without complex
documents, visual review remains shallow. A developer might inspect an empty
workspace and believe the layout is fine, then miss failures that only appear
when the sidebar contains many pages, the main document has long text, and cards
need to summarize real content.

This fixture complements the other four documents. The typography stress file
checks heading density. The runbook checks operational tables and commands. The
gallery checks image-heavy pages. The compact smoke fixture checks short content.
This file is the deliberately long narrative document.

#### Background Table

| Need               | Why It Matters                 | Fixture Signal            |
| ------------------ | ------------------------------ | ------------------------- |
| Long prose         | Tests line height and wrapping | Several long sections     |
| Searchable body    | Tests index and snippets       | Distinct repeated phrases |
| Realistic headings | Tests outline and scanning     | H1 through H6             |
| Mixed content      | Tests block transitions        | Lists, table, media, code |

##### Background Notes

The table is intentionally small. The focus of this fixture is prose, not table
density.

###### Background Leaf

This leaf keeps outline depth present while staying subordinate to the prose.

## Requirements

### Requirement 1 - Discoverability

The seeded document must be visible in every active workspace after the seed
script finishes. It should not require a manual refresh of root document state,
and it should not create duplicate pages when the seed runs again. The visible
title should clearly indicate that the page is a long text fixture.

#### Acceptance Criteria 1

1. The document appears in normal document navigation.
2. Re-running the seed keeps the same document ID.
3. Search can find `long-text-requirements-fixture`.
4. Preview text includes meaningful prose rather than only headings.

##### Notes 1

Discoverability is partly a data problem and partly a presentation problem.
Both matter for this fixture.

###### Leaf 1

Small headings should remain calm and readable.

### Requirement 2 - Reading Comfort

Long-form reading comfort depends on consistent typography. The body text should
not feel cramped, oversized, overly decorative, or disconnected from headings.
Line wrapping should stay stable in the editor and in previews. Paragraphs
should have enough air to scan but not so much that the document feels broken
into unrelated fragments.

The document intentionally contains several paragraphs of similar size. This is
useful because a single long paragraph can be dismissed as an edge case, while
a realistic sequence of medium-long paragraphs reveals whether the underlying
system has a sustainable rhythm.

#### Acceptance Criteria 2

- Body copy remains readable without local visual overrides.
- Heading hierarchy remains obvious in the middle of the document.
- Inline formatting such as **important**, _conditional_, and `monospace`
  remains distinguishable.
- Search extraction keeps useful words from the middle of the document.

##### Notes 2

If this document looks worse than the shorter fixtures, the typography system is
probably too dependent on surrounding layout.

###### Leaf 2

The smallest headings should not become metadata labels or captions.

### Requirement 3 - Preview Behavior

Document previews need to summarize enough content to help the user choose the
right page. For a long document, the preview should not rely only on the first
heading. It should show body text that makes the document type recognizable.
The phrase preview truncation marker appears here so automated and manual checks
can search for it.

#### Acceptance Criteria 3

1. List view keeps the title readable.
2. Card view shows a sensible excerpt.
3. Compact view does not hide the document entirely.
4. The action menu remains available and visually separate from the excerpt.

##### Notes 3

Preview logic should not need a special case for this document. The fixture is
designed to look like a real long note.

###### Leaf 3

This leaf helps distinguish heading styles from preview captions.

### Requirement 4 - Editing and Persistence

The editor should load this document through the same Yjs path used by all
seeded documents. It should preserve enough structure for editing and search
even where the Markdown bridge represents advanced structures in a simplified
way. The goal is not perfect Markdown roundtrip fidelity; the goal is realistic
rendering pressure.

#### Acceptance Criteria 4

- The document opens without errors.
- The first heading becomes the visible title.
- Body text is stored in searchable metadata.
- Seed refresh updates content when the fixture changes.

##### Notes 4

Refresh behavior matters because fixture quality will improve over time. A seed
that refuses to update existing documents becomes a source of stale visual data.

###### Leaf 4

The refresh path should not duplicate root document page entries.

## Long Narrative Section

### Narrative A - Workspace Review

A workspace review workflow begins with orientation. The user needs to know
which workspace they are in, which documents are available, what filters are
active, and whether a document is shared, personal, or organizational. If the
interface provides too many controls at once, the user loses the thread. If it
provides too little context, the user cannot understand why a document appears
or disappears.

The document list is especially sensitive. It sits between navigation, search,
organization, and content. A good document list should not look like a random
pile of controls. It should make selection, filtering, sorting, and document
actions feel related. This fixture provides enough content to expose whether
the list handles substantial text gracefully.

#### Narrative A Details

Workspace review also involves trust. When the user sees the same five complex
documents in every seed workspace, they can compare behavior across personal
and shared contexts. Differences should be caused by permissions or data, not
by inconsistent rendering.

##### Narrative A Detail Note

The phrase workspace review narrative marker exists for search checks.

###### Narrative A Leaf

Leaf text stays intentionally simple.

### Narrative B - Typography Review

Typography review is not only about font family. It includes scale, weight,
line height, spacing, code style, heading rhythm, and how all of those choices
behave in dense content. A long page makes the system show whether it has a
coherent baseline. It also makes overfitted local CSS easier to notice because
small inconsistencies repeat many times.

This paragraph includes **bold text for decisions**, _italic text for caveats_,
and `inline_code_for_tokens`. It is followed by ordinary prose so the inline
styles can be inspected in context rather than as isolated examples.

#### Narrative B Details

When typography is correct, the document can be scanned without thinking about
the implementation. When it is wrong, the user sees awkward gaps, sudden weight
changes, or code fragments that look like accidental badges.

##### Narrative B Detail Note

The text should remain readable in both light and dark themes.

###### Narrative B Leaf

The heading depth remains present but unobtrusive.

### Narrative C - Search and Snippets

Search needs long documents because a short document almost always yields a
reasonable snippet by accident. Long documents require better extraction. The
search snippet should not be dominated by table separators, media URLs, or code
syntax. It should surface phrases that help the reader understand why the
document matched.

This fixture repeats a few stable markers: long-text-requirements-fixture,
search snippet marker, typography review marker, and preview truncation marker.
These phrases should remain discoverable after import and after seed refresh.

#### Narrative C Details

Search results are a compact UI surface. They are a good place to notice if
document metadata, title extraction, or plain-text projection has drifted away
from editor behavior.

##### Narrative C Detail Note

Search should never require the user to open every candidate document manually.

###### Narrative C Leaf

This leaf contains the phrase search snippet leaf marker.

### Narrative D - Visual Balance

This document has very little media by design. The seed set already contains a
gallery document for graphics-heavy testing. Here, the absence of many images is
the point. It allows reviewers to focus on prose, headings, lists, and preview
behavior without the page becoming a media test.

#### Narrative D Details

Balanced visual design means different document types can coexist. A short
note, a long requirements document, a runbook, a report, and a gallery should
not all look identical. They should share a system while preserving their own
content character.

##### Narrative D Detail Note

The phrase content character marker helps identify this section in search.

###### Narrative D Leaf

The leaf remains ordinary prose.

## Lists

### Ordered Review Flow

1. Seed the standard local dataset.
2. Open each workspace as an accepted member.
3. Confirm the five fixture documents are visible.
4. Search for long-text-requirements-fixture.
5. Open the document and scroll through every section.
6. Re-run the seed and confirm the document count stays stable.

### Bullet Review Flow

- Inspect the title in list and card views.
- Inspect prose wrapping in the editor.
- Inspect inline **bold**, _italic_, and `code` marks.
- Inspect the document after a seed refresh.
- Inspect the root document page entry count.

## Minimal Media

![Long text SVG marker](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='420'%20height='120'%20viewBox='0%200%20420%20120'%3E%3Crect%20width='420'%20height='120'%20rx='16'%20fill='%23f8fafc'/%3E%3Crect%20x='42'%20y='30'%20width='254'%20height='16'%20rx='8'%20fill='%23111827'/%3E%3Crect%20x='42'%20y='58'%20width='330'%20height='12'%20rx='6'%20fill='%2364748b'/%3E%3Crect%20x='42'%20y='82'%20width='286'%20height='12'%20rx='6'%20fill='%2394a3b8'/%3E%3C/svg%3E)

![Long text PNG marker](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)

## Implementation Notes

```ts
export const longTextRequirementsFixture = {
  marker: "long-text-requirements-fixture",
  profile: "long-text-heavy",
  expectedRefresh: "same-document-id",
  expectedSearch: ["search snippet marker", "preview truncation marker"],
};
```

## Final Review Notes

The final section exists so the document still contains meaningful content near
the bottom. Reviewers should scroll far enough to see whether sticky headers,
sidebars, title bars, and document content keep their relationship over time.
Long documents reveal fatigue in a design system. If the interface still feels
calm here, the typography and layout foundations are likely in better shape.

### Final Checklist

- The document is longer than the other seed documents.
- The document is primarily prose.
- The document has all heading levels.
- The document has tables, lists, code, SVG, PNG, bold, italic, and inline code.
- The document can refresh in place when the fixture changes.

#### Final Detail

This last detail keeps the heading hierarchy alive near the end of the page.

##### Final Subdetail

The text remains intentionally plain.

###### Final Leaf

End of the long text requirements fixture.
