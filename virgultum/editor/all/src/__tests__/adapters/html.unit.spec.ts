import {
  DefaultTheme,
  NoteDisplayMode,
  type TableCellSerialized,
  TableModelFlavour,
} from "@virgultum/model";
import {
  embedSyncedDocMiddleware,
  HtmlAdapter,
  DOCUMENT_REFERENCE_TITLE_PREFIX,
} from "@virgultum/shared/adapters";
import {
  AssetsManager,
  type BlockSnapshot,
  type DocSnapshot,
  MemoryBlobCRUD,
  type TransformerMiddleware,
} from "@virgultum/store";
import { describe, expect, test } from "vitest";

import { createJob } from "../utils/create-job.js";
import { getProvider } from "../utils/get-provider.js";
import { nanoidReplacement } from "../utils/nanoid-replacement.js";

const provider = getProvider();

describe("snapshot to html", () => {
  const template = (html: string, title?: string) => {
    let htmlTemplate = `
  <!doctype html>
  <html>
  <head><meta charset="utf-8">
    <style>
      .todo-list {
        list-style: none;
        padding-inline-start: 1.5rem;
      }
      .todo-list-label {
        align-items: baseline;
        display: inline-flex;
        gap: 0.5rem;
      }
    </style>
  </head>
  <body>
  <div style="width: 70vw; margin: 60px auto;"><!--VirgultumDocTitlePlaceholder-->
  <!--HtmlTemplate-->
  </div>
  </body>
  </html>
  `
      .replace(/\s\s+|\n/g, "")
      .replace("<!--HtmlTemplate-->", html);
    if (title) {
      htmlTemplate = htmlTemplate.replace(
        "<!--VirgultumDocTitlePlaceholder-->",
        `<h1>${title}</h1>`,
      );
    }
    return htmlTemplate;
  };

  const paragraphTemplate = (html: string) =>
    `<div class="myoxus-paragraph-block-container">${html}<div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`;

  test("code", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:8hOLxad5Fv",
              flavour: "myoxus:code",
              props: {
                language: "python",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "import this",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const html = template(
      `<pre><code class="code-python">import this</code></pre>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("code upper case", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:8hOLxad5Fv",
              flavour: "myoxus:code",
              props: {
                language: "PYTHON",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "import this",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const html = template(
      `<pre><code class="code-PYTHON">import this</code></pre>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("code unknown", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:8hOLxad5Fv",
              flavour: "myoxus:code",
              props: {
                language: "unknown",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "import this",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const html = template(
      `<pre><code class="code-unknown">import this</code></pre>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("paragraph", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Bdn8Yvqcny",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                presentation: "eyebrow",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                      attributes: {
                        labelTone: "accent",
                      },
                    },
                  ],
                },
              },
              children: [
                {
                  type: "block",
                  id: "block:72SMa5mdLy",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    presentation: "future",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                  },
                  children: [],
                },
                {
                  type: "block",
                  id: "block:f-Z6nRrGK_",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ccc",
                        },
                      ],
                    },
                  },
                  children: [
                    {
                      type: "block",
                      id: "block:sP3bU52el7",
                      flavour: "myoxus:paragraph",
                      props: {
                        type: "text",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "ddd",
                            },
                          ],
                        },
                      },
                      children: [],
                    },
                    {
                      type: "block",
                      id: "block:X_HMxP4wxC",
                      flavour: "myoxus:paragraph",
                      props: {
                        type: "text",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "eee",
                            },
                          ],
                        },
                      },
                      children: [],
                    },
                    {
                      type: "block",
                      id: "block:iA34Rb-RvV",
                      flavour: "myoxus:paragraph",
                      props: {
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "fff",
                            },
                          ],
                        },
                        type: "text",
                      },
                      children: [],
                    },
                  ],
                },
                {
                  type: "block",
                  id: "block:I0Fmz5Nv02",
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ggg",
                        },
                      ],
                    },
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:12lDwMD7ec",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "hhh",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const html = template(
      `<div class="myoxus-paragraph-block-container"><p data-myoxus-paragraph-presentation="eyebrow"><span data-myoxus-label-tone="accent">aaa</span></p><div class="myoxus-block-children-container" style="padding-left: 26px;"><div class="myoxus-paragraph-block-container"><p>bbb</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div><div class="myoxus-paragraph-block-container"><p>ccc</p><div class="myoxus-block-children-container" style="padding-left: 26px;"><div class="myoxus-paragraph-block-container"><p>ddd</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div><div class="myoxus-paragraph-block-container"><p>eee</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div><div class="myoxus-paragraph-block-container"><p>fff</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div></div></div><div class="myoxus-paragraph-block-container"><p>ggg</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div></div></div><div class="myoxus-paragraph-block-container"><p>hhh</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("bulleted list", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [
                {
                  type: "block",
                  id: "block:kYliRIovvL",
                  flavour: "myoxus:list",
                  props: {
                    type: "bulleted",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "bbb",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [
                    {
                      type: "block",
                      id: "block:UyvxA_gqCJ",
                      flavour: "myoxus:list",
                      props: {
                        type: "bulleted",
                        text: {
                          "$virgultum:internal:text$": true,
                          delta: [
                            {
                              insert: "ccc",
                            },
                          ],
                        },
                        checked: false,
                        collapsed: false,
                      },
                      children: [],
                    },
                  ],
                },
                {
                  type: "block",
                  id: "block:-guNZRm5u1",
                  flavour: "myoxus:list",
                  props: {
                    type: "bulleted",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: [
                        {
                          insert: "ddd",
                        },
                      ],
                    },
                    checked: false,
                    collapsed: false,
                  },
                  children: [],
                },
              ],
            },
            {
              type: "block",
              id: "block:B9CaZzQ2CO",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "eee",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
          ],
        },
      ],
    };
    const html = template(
      `<ul class="bulleted-list"><li class="myoxus-list-block-container">aaa<ul class="bulleted-list"><li class="myoxus-list-block-container">bbb<ul class="bulleted-list"><li class="myoxus-list-block-container">ccc</li></ul></li><li class="myoxus-list-block-container">ddd</li></ul></li><li class="myoxus-list-block-container">eee</li></ul>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("different list types keep their semantic HTML", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "todo",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "bbb",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "numbered",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ccc",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
                order: 1,
              },
              children: [],
            },
            {
              type: "block",
              id: "block:imiLDMKSkx",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "ddd",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
              },
              children: [],
            },
          ],
        },
      ],
    };
    const html = template(
      `<ul class="bulleted-list"><li class="myoxus-list-block-container">aaa</li></ul><ul class="todo-list"><li class="myoxus-list-block-container"><label class="todo-list-label"><input type="checkbox" disabled>bbb</label></li></ul><ol class="numbered-list"><li class="myoxus-list-block-container">ccc</li></ol><ul class="bulleted-list"><li class="myoxus-list-block-container">ddd</li></ul>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
    expect(target.file.match(/type="checkbox"/g)).toHaveLength(1);
    expect(target.file).not.toContain("</input>");
  });

  test("code inline", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:qhpbuss-KN",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa ",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        code: true,
                      },
                    },
                    {
                      insert: " ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const html = template(
      `<div class="myoxus-paragraph-block-container"><p>aaa <code>bbb</code> ccc</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("link", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Bdn8Yvqcny",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa ",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        link: "https://example.com/",
                      },
                    },
                    {
                      insert: " ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };
    const html = template(
      `<div class="myoxus-paragraph-block-container"><p>aaa <a href="https://example.com/">bbb</a> ccc</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("bold", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:zxDyvrg1Mh",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        bold: true,
                      },
                    },
                    {
                      insert: "ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const html = template(
      `<div class="myoxus-paragraph-block-container"><p>aaa<strong>bbb</strong>ccc</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("italic", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:vu6SK6WJpW",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:Tk4gSPocAt",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:WfnS5ZDCJT",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:zxDyvrg1Mh",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "aaa",
                    },
                    {
                      insert: "bbb",
                      attributes: {
                        italic: true,
                      },
                    },
                    {
                      insert: "ccc",
                    },
                  ],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const html = template(
      `<div class="myoxus-paragraph-block-container"><p>aaa<em>bbb</em>ccc</p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
    });
    expect(target.file).toBe(html);
  });

  test("image", async () => {
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "block:WcYcyv-oZY",
      flavour: "myoxus:page",
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [],
        },
      },
      children: [
        {
          type: "block",
          id: "block:zqtuv999Ww",
          flavour: "myoxus:surface",
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "block:UTUZojv22c",
          flavour: "myoxus:note",
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "block:Gan31s-dYK",
              flavour: "myoxus:image",
              props: {
                sourceId: "YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=",
                caption: "aaa",
                width: 0,
                height: 0,
                index: "a0",
                xywh: "[0,0,0,0]",
                rotate: 0,
              },
              children: [],
            },
            {
              type: "block",
              id: "block:If92CIQiOl",
              flavour: "myoxus:paragraph",
              props: {
                type: "text",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [],
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const html = template(
      `<figure class="myoxus-image-block-container"><img src="assets/YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=.blob" alt="YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=.blob" title="aaa"></figure><div class="myoxus-paragraph-block-container"><p></p><div class="myoxus-block-children-container" style="padding-left: 26px;"></div></div>`,
    );

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const blobManager = new MemoryBlobCRUD();
    await blobManager.set(
      "YXXTjRmLlNyiOUnHb8nAIvUP6V7PAXhwW9F5_tc2LGs=",
      new Blob(),
    );
    const assets = new AssetsManager({ blob: blobManager });

    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapshot,
      assets,
    });
    expect(target.file).toBe(html);
  });

  describe("embed link block", () => {
    const embedTestCases = [
      {
        name: "bookmark",
        flavour: "myoxus:bookmark",
        url: "https://example.com",
        title: "example",
      },
      {
        name: "embed github",
        flavour: "myoxus:embed-github",
        url: "https://github.com/example/virgultum/pull/66666",
        title: "example github pr title",
      },
      {
        name: "embed figma",
        flavour: "myoxus:embed-figma",
        url: "https://www.figma.com/file/1234567890",
        title: "example figma title",
      },
      {
        name: "embed youtube",
        flavour: "myoxus:embed-youtube",
        url: "https://www.youtube.com/watch?v=1234567890",
        title: "example youtube title",
      },
      {
        name: "embed loom",
        flavour: "myoxus:embed-loom",
        url: "https://www.loom.com/share/1234567890",
        title: "example loom title",
      },
    ];

    for (const testCase of embedTestCases) {
      test(testCase.name, async () => {
        const blockSnapshot: BlockSnapshot = {
          type: "block",
          id: "block:vu6SK6WJpW",
          flavour: "myoxus:page",
          props: {
            title: {
              "$virgultum:internal:text$": true,
              delta: [],
            },
          },
          children: [
            {
              type: "block",
              id: "block:Tk4gSPocAt",
              flavour: "myoxus:surface",
              props: {
                elements: {},
              },
              children: [],
            },
            {
              type: "block",
              id: "block:WfnS5ZDCJT",
              flavour: "myoxus:note",
              props: {
                xywh: "[0,0,800,95]",
                background: DefaultTheme.noteBackgrounColor,
                index: "a0",
                hidden: false,
                displayMode: NoteDisplayMode.DocAndEdgeless,
              },
              children: [
                {
                  type: "block",
                  id: "block:Bdn8Yvqcny",
                  flavour: testCase.flavour,
                  props: {
                    url: testCase.url,
                    title: testCase.title,
                  },
                  children: [],
                },
              ],
            },
          ],
        };

        const html = template(
          `<div class="myoxus-paragraph-block-container"><a href="${testCase.url}">${testCase.title}</a></div>`,
        );

        const htmlAdapter = new HtmlAdapter(createJob(), provider);
        const target = await htmlAdapter.fromBlockSnapshot({
          snapshot: blockSnapshot,
        });
        expect(target.file).toBe(html);
      });
    }
  });

  test("linked doc block", async () => {
    const blockSnapShot: BlockSnapshot = {
      type: "block",
      id: "VChAZIX7DM",
      flavour: "myoxus:page",
      version: 2,
      props: {
        title: {
          "$virgultum:internal:text$": true,
          delta: [
            {
              insert: "Test Doc",
            },
          ],
        },
      },
      children: [
        {
          type: "block",
          id: "uRj8gejH4d",
          flavour: "myoxus:surface",
          version: 5,
          props: {
            elements: {},
          },
          children: [],
        },
        {
          type: "block",
          id: "AqFoVDUoW9",
          flavour: "myoxus:note",
          version: 1,
          props: {
            xywh: "[0,0,800,95]",
            background: DefaultTheme.noteBackgrounColor,
            index: "a0",
            hidden: false,
            displayMode: NoteDisplayMode.DocAndEdgeless,
          },
          children: [
            {
              type: "block",
              id: "C0sH2Ee6cz-MysVNLNrBt",
              flavour: "myoxus:embed-linked-doc",
              props: {
                index: "a0",
                xywh: "[0,0,0,0]",
                rotate: 0,
                pageId: "4T5ObMgEIMII-4Bexyta1",
                style: "horizontal",
                caption: null,
                params: {
                  mode: "page",
                  blockIds: ["abc", "123"],
                  elementIds: ["def", "456"],
                  databaseId: "deadbeef",
                  databaseRowId: "123",
                },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const middleware: TransformerMiddleware = ({ adapterConfigs }) => {
      adapterConfigs.set("title:4T5ObMgEIMII-4Bexyta1", "Test Doc");
      adapterConfigs.set(
        DOCUMENT_REFERENCE_TITLE_PREFIX + "4T5ObMgEIMII-4Bexyta1",
        "Test Doc",
      );
      adapterConfigs.set("docLinkBaseUrl", "https://example.com");
    };
    const html = template(
      '<div class="myoxus-paragraph-block-container"><a href="https://example.com/4T5ObMgEIMII-4Bexyta1?mode=page&#x26;blockIds=abc%2C123&#x26;elementIds=def%2C456&#x26;databaseId=deadbeef&#x26;databaseRowId=123">Test Doc</a></div>',
    );
    const htmlAdapter = new HtmlAdapter(createJob([middleware]), provider);
    const target = await htmlAdapter.fromBlockSnapshot({
      snapshot: blockSnapShot,
    });
    expect(target.file).toBe(html);
  });

  test("synced doc block", async () => {
    // doc -> synced doc block -> deepest synced doc block
    // The deepest synced doc block only export it's title

    const deepestSyncedDocSnapshot: DocSnapshot = {
      type: "page",
      meta: {
        id: "deepestSyncedDoc",
        title: "Deepest Doc",
        createDate: 1715762171116,
        tags: [],
      },
      blocks: {
        type: "block",
        id: "8WdJmN5FTT",
        flavour: "myoxus:page",
        version: 2,
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Deepest Doc",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: "zVN1EZFuZe",
            flavour: "myoxus:surface",
            version: 5,
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "2s9sJlphLH",
            flavour: "myoxus:note",
            version: 1,
            props: {
              xywh: "[0,0,800,95]",
              background: DefaultTheme.noteBackgrounColor,
              index: "a0",
              hidden: false,
              displayMode: "both",
              edgeless: {
                style: {
                  borderRadius: 8,
                  borderSize: 4,
                  borderStyle: "solid",
                  shadowType: "--myoxus-note-shadow-box",
                },
              },
            },
            children: [
              {
                type: "block",
                id: "vNp5XrR5yw",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "JTdfSl1ygZ",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Hello, This is deepest doc.",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      },
    };

    const syncedDocSnapshot: DocSnapshot = {
      type: "page",
      meta: {
        id: "syncedDoc",
        title: "Synced Doc",
        createDate: 1719212435051,
        tags: [],
      },
      blocks: {
        type: "block",
        id: "AGOahFisBN",
        flavour: "myoxus:page",
        version: 2,
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Synced Doc",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: "gfVzx5tGpB",
            flavour: "myoxus:surface",
            version: 5,
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "CzEfaUret4",
            flavour: "myoxus:note",
            version: 1,
            props: {
              xywh: "[0,0,800,95]",
              background: "--myoxus-note-background-blue",
              index: "a0",
              hidden: false,
              displayMode: "both",
              edgeless: {
                style: {
                  borderRadius: 0,
                  borderSize: 4,
                  borderStyle: "none",
                  shadowType: "--myoxus-note-shadow-sticker",
                },
              },
            },
            children: [
              {
                type: "block",
                id: "yFlNufsgke",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "h1",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Heading 1",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "oMuLcD6XS3",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "h2",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "heading 2",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "PQ8FhGV6VM",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "paragraph",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "sA9paSrdEN",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "strike",
                        attributes: {
                          strike: true,
                        },
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "-3bbVQTvI2",
                flavour: "myoxus:embed-synced-doc",
                version: 1,
                props: {
                  index: "a0",
                  xywh: "[0,0,0,0]",
                  rotate: 0,
                  pageId: "deepestSyncedDoc",
                  style: "syncedDoc",
                },
                children: [],
              },
            ],
          },
        ],
      },
    };

    const syncedDocHtml =
      paragraphTemplate("<h1>Heading 1</h1>") +
      paragraphTemplate("<h2>heading 2</h2>") +
      paragraphTemplate("<p>paragraph</p>") +
      paragraphTemplate("<p><del>strike</del></p>");

    const docSnapShot: DocSnapshot = {
      type: "page",
      meta: {
        id: "y5nsrywQtr",
        title: "Test Doc",
        createDate: 1719222172042,
        tags: [],
      },
      blocks: {
        type: "block",
        id: "VChAZIX7DM",
        flavour: "myoxus:page",
        version: 2,
        props: {
          title: {
            "$virgultum:internal:text$": true,
            delta: [
              {
                insert: "Test Doc",
              },
            ],
          },
        },
        children: [
          {
            type: "block",
            id: "uRj8gejH4d",
            flavour: "myoxus:surface",
            version: 5,
            props: {
              elements: {},
            },
            children: [],
          },
          {
            type: "block",
            id: "AqFoVDUoW9",
            flavour: "myoxus:note",
            version: 1,
            props: {
              xywh: "[0,0,800,95]",
              background: "--myoxus-note-background-blue",
              index: "a0",
              hidden: false,
              displayMode: "both",
              edgeless: {
                style: {
                  borderRadius: 0,
                  borderSize: 4,
                  borderStyle: "none",
                  shadowType: "--myoxus-note-shadow-sticker",
                },
              },
            },
            children: [
              {
                type: "block",
                id: "cWBI4UGTqh",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "Hello",
                      },
                    ],
                  },
                },
                children: [],
              },
              {
                type: "block",
                id: "AqFoVxas19",
                flavour: "myoxus:embed-synced-doc",
                version: 1,
                props: {
                  index: "a0",
                  xywh: "[0,0,0,0]",
                  rotate: 0,
                  pageId: "syncedDoc",
                  style: "syncedDoc",
                },
                children: [],
              },
              {
                type: "block",
                id: "Db976U9v18",
                flavour: "myoxus:paragraph",
                version: 1,
                props: {
                  type: "text",
                  text: {
                    "$virgultum:internal:text$": true,
                    delta: [
                      {
                        insert: "World!",
                      },
                    ],
                  },
                },
                children: [],
              },
            ],
          },
        ],
      },
    };

    const docHtml = template(
      paragraphTemplate("<p>Hello</p>") +
        syncedDocHtml +
        '<div class="myoxus-paragraph-block-container"><p>Deepest Doc</p></div>' +
        paragraphTemplate("<p>World!</p>"),
      "Test Doc",
    );

    const job = createJob([embedSyncedDocMiddleware("content")]);

    // workaround for adding docs to collection
    await job.snapshotToDoc(deepestSyncedDocSnapshot);
    await job.snapshotToDoc(syncedDocSnapshot);
    await job.snapshotToDoc(docSnapShot);
    for (const snapshot of [
      deepestSyncedDocSnapshot,
      syncedDocSnapshot,
      docSnapShot,
    ]) {
      const doc = job.docCRUD.get(snapshot.meta.id)!;
      doc.workspace.meta.setDocMeta(snapshot.meta.id, {
        title: snapshot.meta.title,
      });
    }

    const mdAdapter = new HtmlAdapter(job, provider);
    const target = await mdAdapter.fromDocSnapshot({
      snapshot: docSnapShot,
    });
    expect(target.file).toBe(docHtml);
  });
});

describe("html to snapshot", () => {
  const template = (html: string) =>
    `
  <!doctype html>
  <html>
  <head><meta charset="utf-8">
    <style>
      .todo-list {
        list-style: none;
        padding-inline-start: 1.5rem;
      }
      .todo-list-label {
        align-items: baseline;
        display: inline-flex;
        gap: 0.5rem;
      }
    </style>
  </head>
  <body>
  <!--StartFragment-->
  <!--HtmlTemplate-->
  <!--EndFragment-->

  </body>
  </html>
  `.replace("<!--HtmlTemplate-->", html);

  test("code", async () => {
    const html = template(
      `<pre><code class="code-python"><span style="word-wrap: break-word; color: #81A1C1;">import</span><span style="word-wrap: break-word; color: #D8DEE9FF;"> this</span></code></pre>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:code",
          props: {
            language: "python",
            wrap: false,
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "import this",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("table header rows preserve explicit semantics and infer external headers", async () => {
    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const importTable = async (table: string) => {
      const snapshot = await htmlAdapter.toBlockSnapshot({
        file: template(table),
      });
      const block = snapshot.children.find(
        (child) => child.flavour === TableModelFlavour,
      );
      expect(block).toBeDefined();
      return { snapshot, block: block! };
    };

    const explicit = await importTable(
      `<table data-myoxus-table-header-rows="2" data-myoxus-table-appearance="ruled" data-myoxus-table-density="compact"><tbody><tr><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td></tr></tbody></table>`,
    );
    expect(explicit.block.props.headerRows).toBe(2);
    expect(explicit.block.props.appearance).toBe("ruled");
    expect(explicit.block.props.density).toBe("compact");
    const exported = await htmlAdapter.fromBlockSnapshot({
      snapshot: explicit.snapshot,
    });
    expect(exported.file).toContain(`data-myoxus-table-header-rows="2"`);
    expect(exported.file).toContain(`data-myoxus-table-appearance="ruled"`);
    expect(exported.file).toContain(`data-myoxus-table-density="compact"`);
    const exportedDom = new DOMParser().parseFromString(
      exported.file,
      "text/html",
    );
    expect(exportedDom.querySelectorAll('th[scope="col"]')).toHaveLength(2);
    expect(exportedDom.querySelectorAll("td")).toHaveLength(1);
    explicit.block.props.headerRows = 0;
    const exportedZero = await htmlAdapter.fromBlockSnapshot({
      snapshot: explicit.snapshot,
    });
    expect(exportedZero.file).toContain(`data-myoxus-table-header-rows="0"`);
    expect(exportedZero.file).not.toContain("<thead>");
    expect(
      new DOMParser()
        .parseFromString(exportedZero.file, "text/html")
        .querySelectorAll("td"),
    ).toHaveLength(3);

    const inferredThead = await importTable(
      `<table><thead><tr><th style="background-color:--myoxus-sem-status-success-paper">A</th></tr><tr><th style="background-color:var(--myoxus-tag-green)">B</th></tr></thead><tbody><tr><td style="background-color:rgb(255 0 0 / 50%)">C</td></tr></tbody></table>`,
    );
    expect(inferredThead.block.props.headerRows).toBe(2);
    expect(
      Object.values(
        inferredThead.block.props.cells as Record<string, TableCellSerialized>,
      ).map((cell) => cell.backgroundColor),
    ).toEqual([
      "--myoxus-sem-status-success-paper",
      "--myoxus-tag-green",
      "#ff000080",
    ]);

    const inferredCells = await importTable(
      `<table><tbody><tr><th style="background-color:expression(alert(1));color:red">A</th></tr><tr><th>B</th></tr><tr><td>C</td></tr></tbody></table>`,
    );
    expect(inferredCells.block.props.headerRows).toBe(2);
    expect(
      Object.values(
        inferredCells.block.props.cells as Record<string, TableCellSerialized>,
      ).every((cell) => !Object.hasOwn(cell, "backgroundColor")),
    ).toBe(true);

    const explicitZero = await importTable(
      `<table data-myoxus-table-header-rows="invalid" data-myoxus-table-appearance="future" data-myoxus-table-density="dense"><thead><tr><th>A</th></tr></thead></table>`,
    );
    expect(explicitZero.block.props.headerRows).toBe(0);
    expect(explicitZero.block.props.appearance).toBeUndefined();
    expect(explicitZero.block.props.density).toBeUndefined();
  });

  test("paragraph", async () => {
    const html = template(
      `<p data-myoxus-paragraph-presentation="eyebrow"><span data-myoxus-label-tone="accent">aaa</span></p><p data-myoxus-paragraph-presentation="future"><span data-myoxus-label-tone="future">bbb</span></p><p>ccc</p><p>ddd</p><p>eee</p>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            presentation: "eyebrow",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                  attributes: {
                    labelTone: "accent",
                  },
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "bbb",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "ccc",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[4]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "ddd",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "eee",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("paragraph with br should split into multiple blocks", async () => {
    const html = template(`<p>aaa<br>bbb<br>ccc</p>`);

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "aaa" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "bbb" }],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [{ insert: "ccc" }],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("paragraph with br should keep inline styles in each split line", async () => {
    const html = template(
      `<p><strong>aaa</strong><br><a href="https://www.google.com/">bbb</a><br><em>ccc</em></p>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                  attributes: {
                    bold: true,
                  },
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "bbb",
                  attributes: {
                    link: "https://www.google.com/",
                  },
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "ccc",
                  attributes: {
                    italic: true,
                  },
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("nested list", async () => {
    const html = template(`<ul><li>111<ul><li>222</li></ul></li></ul>`);

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:list",
          props: {
            type: "bulleted",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "111",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: null,
          },
          children: [
            {
              type: "block",
              id: "matchesReplaceMap[2]",
              flavour: "myoxus:list",
              props: {
                type: "bulleted",
                text: {
                  "$virgultum:internal:text$": true,
                  delta: [
                    {
                      insert: "222",
                    },
                  ],
                },
                checked: false,
                collapsed: false,
                order: null,
              },
              children: [],
            },
          ],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("p in list", async () => {
    const html = template(`<ol><li><p>p in list</p></li></ol>`);

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:list",
          props: {
            type: "numbered",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "p in list",
                },
              ],
            },
            checked: false,
            collapsed: false,
            order: null,
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("exported todo list round-trips as a checked todo", async () => {
    const html = template(
      `<ul class="todo-list"><li class="myoxus-list-block-container"><label class="todo-list-label"><input type="checkbox" checked disabled>done</label></li></ul>`,
    );
    const htmlAdapter = new HtmlAdapter(createJob(), provider);

    const rawBlockSnapshot = nanoidReplacement(
      await htmlAdapter.toBlockSnapshot({ file: html }),
    );
    const todo = rawBlockSnapshot.children[0];

    expect(todo).toMatchObject({
      flavour: "myoxus:list",
      props: {
        type: "todo",
        checked: true,
        text: {
          delta: [{ insert: "done" }],
        },
      },
    });
  });

  test("iframe", async () => {
    const html = template(
      `<iframe width="560" height="315" src="https://www.youtube.com/embed/QDsd0nyzwz0?start=&amp;end=" title="YouTube video player" frameborder="0" allow="fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin"></iframe>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:embed-youtube",
          props: {
            url: "https://www.youtube.com/watch?v=QDsd0nyzwz0",
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("wrap", async () => {
    const html = template(
      `<p>a\n aa</p><p>b\t bb</p><p>c  cc</p><p>ddd</p><p>eee</p>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "a aa",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[2]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "b bb",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[3]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "c cc",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[4]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "ddd",
                },
              ],
            },
          },
          children: [],
        },
        {
          type: "block",
          id: "matchesReplaceMap[5]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "eee",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("should preserve space in p", async () => {
    const html = template(
      `<p>A <b>bold text</b> followed by a <i>italic text</i></p>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "A ",
                },
                {
                  insert: "bold text",
                  attributes: {
                    bold: true,
                  },
                },
                {
                  insert: " followed by a ",
                },
                {
                  insert: "italic text",
                  attributes: {
                    italic: true,
                  },
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("span nested in p", async () => {
    const html = template(
      `<p><span>aaa</span><span>bbb</span><span>ccc</span></p>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaabbbccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("span nested in div", async () => {
    const html = template(
      `<div><span>aaa</span><span>bbb</span><span>ccc</span></div>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaabbbccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("inline div", async () => {
    const html = template(
      `<span>aaa</span><a href="https://www.google.com/">bbb</a><div style="display:inline">ccc</div>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
                {
                  insert: "bbb",
                  attributes: {
                    link: "https://www.google.com/",
                  },
                },
                {
                  insert: "ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("flex div", async () => {
    const html = template(
      `<div style="display:flex"><span>aaa</span><a href="https://www.google.com/">bbb</a><div>ccc</div></div>`,
    );

    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
                {
                  insert: "bbb",
                  attributes: {
                    link: "https://www.google.com/",
                  },
                },
                {
                  insert: "ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("span inside h1", async () => {
    const html = template(`<h1><span>aaa</span></h1>`);
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "h1",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("p in ancestor", async () => {
    const html = template(`<p><b><span>aaa</span></b></p>`);
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  attributes: {
                    bold: true,
                  },
                  insert: "aaa",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("block level element in b should not be treated as inline", async () => {
    const html = template(`<b><p><span>aaa</span></p></b>`);
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  insert: "aaa",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  describe("strong element", () => {
    test("should not be bold when font-weight is normal", async () => {
      const html = template(`<span style="font-weight: normal;">aaa</span>`);
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:paragraph",
            props: {
              type: "text",
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert: "aaa",
                  },
                ],
              },
            },
            children: [],
          },
        ],
      };

      const htmlAdapter = new HtmlAdapter(createJob(), provider);
      const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
        file: html,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });

    test("should be bold when font-weight is bold or 500-900 ", async () => {
      const html = template(
        `<p><span style="font-weight: bold;">aaa</span><span style="font-weight: 100;">aaa</span><span style="font-weight: 500;">bbb</span><span style="font-weight: 200;">bbb</span><span style="font-weight: 600;">ccc</span><span style="font-weight: 300;">ccc</span><span style="font-weight: 700;">ddd</span></p>`,
      );
      const blockSnapshot: BlockSnapshot = {
        type: "block",
        id: "matchesReplaceMap[0]",
        flavour: "myoxus:note",
        props: {
          xywh: "[0,0,800,95]",
          background: DefaultTheme.noteBackgrounColor,
          index: "a0",
          hidden: false,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        children: [
          {
            type: "block",
            id: "matchesReplaceMap[1]",
            flavour: "myoxus:paragraph",
            props: {
              type: "text",
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    attributes: {
                      bold: true,
                    },
                    insert: "aaa",
                  },
                  {
                    insert: "aaa",
                  },
                  {
                    attributes: {
                      bold: true,
                    },
                    insert: "bbb",
                  },
                  {
                    insert: "bbb",
                  },
                  {
                    attributes: {
                      bold: true,
                    },
                    insert: "ccc",
                  },
                  {
                    insert: "ccc",
                  },
                  {
                    attributes: {
                      bold: true,
                    },
                    insert: "ddd",
                  },
                ],
              },
            },
            children: [],
          },
        ],
      };

      const htmlAdapter = new HtmlAdapter(createJob(), provider);
      const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
        file: html,
      });
      expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
    });
  });

  test("should be italic when tag is i or em or span with style font-style: italic", async () => {
    const html = template(
      `<p><i>aaa</i><span>aaa</span><em>bbb</em><span>bbb</span><span style="font-style: italic;">ccc</span></p>`,
    );
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  attributes: {
                    italic: true,
                  },
                  insert: "aaa",
                },
                {
                  insert: "aaa",
                },
                {
                  attributes: {
                    italic: true,
                  },
                  insert: "bbb",
                },
                {
                  insert: "bbb",
                },
                {
                  attributes: {
                    italic: true,
                  },
                  insert: "ccc",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("should be underline when tag is u or span with style text-decoration: underline", async () => {
    const html = template(
      `<p><u>aaa</u><span>aaa</span><span style="text-decoration: underline;">bbb</span></p>`,
    );
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  attributes: {
                    underline: true,
                  },
                  insert: "aaa",
                },
                {
                  insert: "aaa",
                },
                {
                  attributes: {
                    underline: true,
                  },
                  insert: "bbb",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });

  test("should be strike when tag is del or span with style text-decoration: line-through", async () => {
    const html = template(
      `<p><del>aaa</del><span>aaa</span><span style="text-decoration: line-through;">bbb</span></p>`,
    );
    const blockSnapshot: BlockSnapshot = {
      type: "block",
      id: "matchesReplaceMap[0]",
      flavour: "myoxus:note",
      props: {
        xywh: "[0,0,800,95]",
        background: DefaultTheme.noteBackgrounColor,
        index: "a0",
        hidden: false,
        displayMode: NoteDisplayMode.DocAndEdgeless,
      },
      children: [
        {
          type: "block",
          id: "matchesReplaceMap[1]",
          flavour: "myoxus:paragraph",
          props: {
            type: "text",
            text: {
              "$virgultum:internal:text$": true,
              delta: [
                {
                  attributes: {
                    strike: true,
                  },
                  insert: "aaa",
                },
                {
                  insert: "aaa",
                },
                {
                  attributes: {
                    strike: true,
                  },
                  insert: "bbb",
                },
              ],
            },
          },
          children: [],
        },
      ],
    };

    const htmlAdapter = new HtmlAdapter(createJob(), provider);
    const rawBlockSnapshot = await htmlAdapter.toBlockSnapshot({
      file: html,
    });
    expect(nanoidReplacement(rawBlockSnapshot)).toEqual(blockSnapshot);
  });
});
