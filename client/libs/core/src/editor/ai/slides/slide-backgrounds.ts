function svgUrl(svg: string): string {
  const compact = svg.replace(/\n/g, "").replace(/[\s]{2,}/g, " ");
  return `data:image/svg+xml,${encodeURIComponent(compact)}`;
}

// These are template-owned fallback backgrounds for AI-generated slide decks.
// They replace the removed phantom CDN URLs without adding a new remote asset
// dependency or a parallel server-side static-artwork pipeline.
export const SLIDE_BACKGROUND_URLS = {
  twoSections: svgUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="Canvas"/>
      <path d="M0 0h1120L820 1080H0z" fill="AccentColor" opacity=".08"/>
      <path d="M1920 0v1080h-680L1500 0z" fill="CanvasText" opacity=".04"/>
      <path d="M1240 0 980 1080" stroke="CanvasText" stroke-width="3" opacity=".18"/>
      <path d="M1510 0 1250 1080" stroke="AccentColor" stroke-width="3" opacity=".18"/>
    </svg>
  `),
  threeSections: svgUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="Canvas"/>
      <circle cx="210" cy="180" r="320" fill="AccentColor" opacity=".08"/>
      <circle cx="1730" cy="940" r="380" fill="CanvasText" opacity=".04"/>
      <path d="M360 1040c310-360 680-500 1100-420" fill="none" stroke="CanvasText" stroke-width="8" opacity=".12"/>
      <path d="M520 1010c250-250 560-350 930-300" fill="none" stroke="AccentColor" stroke-width="5" opacity=".14"/>
    </svg>
  `),
  fourSections: svgUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="Canvas"/>
      <rect x="0" y="0" width="960" height="540" fill="AccentColor" opacity=".07"/>
      <rect x="960" y="0" width="960" height="540" fill="CanvasText" opacity=".035"/>
      <rect x="0" y="540" width="960" height="540" fill="CanvasText" opacity=".025"/>
      <rect x="960" y="540" width="960" height="540" fill="AccentColor" opacity=".04"/>
      <path d="M960 0v1080M0 540h1920" stroke="CanvasText" stroke-width="4" opacity=".12"/>
    </svg>
  `),
} as const;
