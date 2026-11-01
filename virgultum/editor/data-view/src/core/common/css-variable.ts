import { cssVar } from "@myoxus/theme";
import { unsafeCSS } from "lit";

export const dataViewCssVariable = () => {
  return `
  --data-view-cell-text-size:var(--mantine-font-size-nav, var(--mantine-font-size-md));
  --data-view-cell-text-line-height:var(--mantine-line-height-nav, var(--mantine-line-height-md));
  --data-view-space-1:var(--mantine-spacing-2xs);
  --data-view-space-2:var(--mantine-spacing-xs);
  --data-view-space-4:var(--mantine-spacing-sm);
  --data-view-icon-sm:var(--mantine-spacing-lg);
  --data-view-icon-md:calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs));
  --data-view-radius-xs:var(--mantine-radius-xs);
  --data-view-radius-sm:var(--mantine-radius-sm);
`;
};
export const dataViewCommonStyle = (selector: string) => `
  ${selector}{
    ${dataViewCssVariable()}
  }
  .with-data-view-css-variable{
    ${dataViewCssVariable()}
    font-family: var(--myoxus-font-family)
  }
  .dv-pd-2{
    padding: var(--data-view-space-1);
  }
  .dv-pd-4{
    padding: var(--data-view-space-2);
  }
  .dv-pd-8{
    padding: var(--data-view-space-4);
  }
  .dv-hover:hover, .dv-hover.active{
    background-color: var(--myoxus-hover-color);
    cursor: pointer;
  }
  .dv-icon-16{
    font-size: var(--data-view-icon-sm);
  }
  .dv-icon-16 svg{
    width: var(--data-view-icon-sm);
    height: var(--data-view-icon-sm);
    color: var(--myoxus-icon-color);
    fill: var(--myoxus-icon-color);
  }
  .dv-icon-20 svg{
    width: var(--data-view-icon-md);
    height: var(--data-view-icon-md);
    color: var(--myoxus-icon-color);
    fill: var(--myoxus-icon-color);
  }
  .dv-border{
    border: 1px solid ${unsafeCSS(cssVar("borderColor"))};
  }
  .dv-round-4{
    border-radius: var(--data-view-radius-xs);
  }
  .dv-round-8{
    border-radius: var(--data-view-radius-sm);
  }
  .dv-color-2{
    color: var(--myoxus-text-secondary-color);
  }
  .dv-shadow-2{
    box-shadow: var(--myoxus-shadow-2)
  }
  .dv-divider-h{
    height: 1px;
    background-color: var(--myoxus-divider-color);
    margin: var(--data-view-space-4) 0;
  }
`;
