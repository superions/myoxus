// SPDX-License-Identifier: AGPL-3.0-or-later

// These persisted role values predate the family-runtime split. Their wire
// values stay stable for deployed documents; the neutral names describe their
// actual ownership and prevent graph consumers from depending on Flowchart.
export const MERMAID_GFX_DETAIL_ROLE = "mermaid-relationship-detail";
export const MERMAID_GFX_EDGE_ROLE = "mermaid-flowchart-edge";
export const MERMAID_GFX_NODE_ROLE = "mermaid-flowchart-node";
export const MERMAID_GFX_SUBGRAPH_ROLE = "mermaid-flowchart-subgraph";
export const MERMAID_GFX_TITLE_ROLE = "mermaid-diagram-title";
export const MERMAID_GFX_TITLE_HEIGHT = 28;
export const MERMAID_GFX_TITLE_BAND_HEIGHT = 32;
