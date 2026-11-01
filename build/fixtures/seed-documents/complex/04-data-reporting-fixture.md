# Visual Asset Gallery Fixture

This graphics-heavy seed stresses image handling, preview extraction, card
density, editor scrolling, and export paths. It intentionally contains many
small inline images, a little body copy, one table, lists, and code.

## Gallery Intent

The document should make visual-media regressions obvious. It is intentionally
less text-heavy than the requirements fixture and more media-heavy than the
runbook or compact smoke fixture.

### Image Set Summary

- Multiple SVG data URIs with different colors and shapes.
- Multiple PNG data URI markers for PNG handling.
- Captions with **bold labels**, _italic notes_, and `asset_identifiers`.
- A mix of wide, compact, circular, and chart-like graphics.

#### Review Checklist

1. Image URLs survive the Markdown import.
2. Preview text remains useful despite many media blocks.
3. The editor does not collapse spacing around consecutive images.
4. Search extraction ignores binary data and keeps captions readable.

##### Gallery Table

| Asset        | Shape       | Purpose                |
| ------------ | ----------- | ---------------------- |
| Hero band    | Wide SVG    | Card and editor width  |
| Status chips | Compact SVG | Repeated media spacing |
| PNG markers  | Tiny PNG    | Data URI type coverage |

###### Leaf Note

This H6 heading ensures the graphics-heavy document still participates in
outline and typography checks.

## SVG Gallery

![Wide blue SVG band](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='520'%20height='140'%20viewBox='0%200%20520%20140'%3E%3Crect%20width='520'%20height='140'%20rx='18'%20fill='%23dbeafe'/%3E%3Ccircle%20cx='80'%20cy='70'%20r='42'%20fill='%232563eb'/%3E%3Crect%20x='158'%20y='42'%20width='230'%20height='18'%20rx='9'%20fill='%231e3a8a'/%3E%3Crect%20x='158'%20y='76'%20width='176'%20height='14'%20rx='7'%20fill='%2360a5fa'/%3E%3C/svg%3E)

![Green process SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='360'%20height='120'%20viewBox='0%200%20360%20120'%3E%3Crect%20width='360'%20height='120'%20rx='14'%20fill='%23dcfce7'/%3E%3Crect%20x='38'%20y='36'%20width='78'%20height='48'%20rx='10'%20fill='%2316a34a'/%3E%3Crect%20x='142'%20y='36'%20width='78'%20height='48'%20rx='10'%20fill='%23059669'/%3E%3Crect%20x='246'%20y='36'%20width='78'%20height='48'%20rx='10'%20fill='%230f766e'/%3E%3Cpath%20d='M120%2060H138M224%2060H242'%20stroke='%23064749'%20stroke-width='6'%20stroke-linecap='round'/%3E%3C/svg%3E)

![Amber chart SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='360'%20height='120'%20viewBox='0%200%20360%20120'%3E%3Crect%20width='360'%20height='120'%20rx='14'%20fill='%23fef3c7'/%3E%3Crect%20x='58'%20y='70'%20width='36'%20height='28'%20fill='%23d97706'/%3E%3Crect%20x='126'%20y='52'%20width='36'%20height='46'%20fill='%23f59e0b'/%3E%3Crect%20x='194'%20y='34'%20width='36'%20height='64'%20fill='%23b45309'/%3E%3Crect%20x='262'%20y='22'%20width='36'%20height='76'%20fill='%2392400e'/%3E%3C/svg%3E)

![Rose curve SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='360'%20height='120'%20viewBox='0%200%20360%20120'%3E%3Crect%20width='360'%20height='120'%20rx='14'%20fill='%23ffe4e6'/%3E%3Cpath%20d='M40%2084C88%2020%20132%2020%20180%2084S276%20148%20320%2036'%20fill='none'%20stroke='%23e11d48'%20stroke-width='8'%20stroke-linecap='round'/%3E%3Ccircle%20cx='40'%20cy='84'%20r='10'%20fill='%239f1239'/%3E%3Ccircle%20cx='180'%20cy='84'%20r='10'%20fill='%239f1239'/%3E%3Ccircle%20cx='320'%20cy='36'%20r='10'%20fill='%239f1239'/%3E%3C/svg%3E)

![Violet nodes SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='360'%20height='120'%20viewBox='0%200%20360%20120'%3E%3Crect%20width='360'%20height='120'%20rx='14'%20fill='%23f3e8ff'/%3E%3Cline%20x1='92'%20y1='60'%20x2='180'%20y2='32'%20stroke='%237c3aed'%20stroke-width='6'/%3E%3Cline%20x1='180'%20y1='32'%20x2='268'%20y2='78'%20stroke='%237c3aed'%20stroke-width='6'/%3E%3Ccircle%20cx='92'%20cy='60'%20r='24'%20fill='%236d28d9'/%3E%3Ccircle%20cx='180'%20cy='32'%20r='24'%20fill='%238b5cf6'/%3E%3Ccircle%20cx='268'%20cy='78'%20r='24'%20fill='%235b21b6'/%3E%3C/svg%3E)

![Cyan swimlane SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='420'%20height='128'%20viewBox='0%200%20420%20128'%3E%3Crect%20width='420'%20height='128'%20rx='16'%20fill='%23ecfeff'/%3E%3Crect%20x='34'%20y='28'%20width='352'%20height='20'%20rx='10'%20fill='%230e7490'/%3E%3Crect%20x='34'%20y='58'%20width='240'%20height='18'%20rx='9'%20fill='%230891b2'/%3E%3Crect%20x='34'%20y='86'%20width='300'%20height='18'%20rx='9'%20fill='%2322d3ee'/%3E%3C/svg%3E)

![Slate wireframe SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='420'%20height='128'%20viewBox='0%200%20420%20128'%3E%3Crect%20width='420'%20height='128'%20rx='16'%20fill='%23f8fafc'/%3E%3Crect%20x='32'%20y='24'%20width='94'%20height='80'%20rx='10'%20fill='none'%20stroke='%23334155'%20stroke-width='5'/%3E%3Crect%20x='152'%20y='24'%20width='236'%20height='18'%20rx='9'%20fill='%23334155'/%3E%3Crect%20x='152'%20y='56'%20width='190'%20height='14'%20rx='7'%20fill='%2394a3b8'/%3E%3Crect%20x='152'%20y='84'%20width='150'%20height='14'%20rx='7'%20fill='%23cbd5e1'/%3E%3C/svg%3E)

![Red alert SVG](data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='300'%20height='110'%20viewBox='0%200%20300%20110'%3E%3Crect%20width='300'%20height='110'%20rx='14'%20fill='%23fee2e2'/%3E%3Cpath%20d='M150%2020L238%2090H62Z'%20fill='%23dc2626'/%3E%3Ccircle%20cx='150'%20cy='72'%20r='6'%20fill='white'/%3E%3Crect%20x='146'%20y='42'%20width='8'%20height='24'%20rx='4'%20fill='white'/%3E%3C/svg%3E)

## PNG Markers

![PNG marker one](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)

![PNG marker two](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=)

## Code Marker

```json
{
  "fixture": "visual-asset-gallery",
  "profile": "graphics-heavy",
  "expectedImages": 10
}
```

## Closing

This document is deliberately graphic-heavy. It should catch cases where media
blocks make lists, previews, cards, or editor spacing unstable.
