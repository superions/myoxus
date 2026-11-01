/**
 * P-DEPS-VIRG-B-01-T — DOMPurify XSS payload regression tests.
 *
 * Verifies that DOMPurify (used by the HTML adapter, PDF adapter, and image utils)
 * correctly sanitises known XSS payloads from the OWASP XSS Filter Evasion Cheatsheet.
 *
 * These tests run in happy-dom (vitest environment), which provides a DOM window for
 * DOMPurify automatically.
 *
 * Reference: https://owasp.org/www-community/xss-filter-evasion-cheatsheet
 * Invariant: Every upgrade to DOMPurify must keep all tests green.
 */
import DOMPurify from "dompurify";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  DOMPurify.clearConfig();
  DOMPurify.removeAllHooks();
});

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["svg", "use"],
    USE_PROFILES: { html: true },
  });
}

/**
 * Returns true if the sanitized HTML still contains a dangerous pattern.
 * Used as a negative assertion: isDangerous(out) must be false after sanitization.
 */
function isDangerous(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("<script") ||
    lower.includes("onerror=") ||
    lower.includes("onload=") ||
    lower.includes("onclick=") ||
    // event handlers generally
    /\bon\w+\s*=/.test(lower) ||
    lower.includes("javascript:") ||
    lower.includes("vbscript:") ||
    lower.includes("eval(") ||
    lower.includes("expression(")
  );
}

describe("DOMPurify — OWASP XSS Filter Evasion (P-DEPS-VIRG-B-01-T)", () => {
  describe("script tag injection", () => {
    it("rejects basic inline script", () => {
      expect(isDangerous(DOMPurify.sanitize("<script>alert(1)</script>"))).toBe(
        false,
      );
    });

    it("rejects script with external src", () => {
      expect(
        isDangerous(
          DOMPurify.sanitize(
            '<script src="http://evil.example/x.js"></script>',
          ),
        ),
      ).toBe(false);
    });

    it("rejects UPPERCASE SCRIPT tag", () => {
      expect(isDangerous(DOMPurify.sanitize("<SCRIPT>alert(1)</SCRIPT>"))).toBe(
        false,
      );
    });

    it("rejects mixed-case ScRiPt", () => {
      expect(isDangerous(DOMPurify.sanitize("<ScRiPt>alert(1)</ScRiPt>"))).toBe(
        false,
      );
    });

    it("rejects script tag with HTML comment obfuscation", () => {
      expect(
        isDangerous(DOMPurify.sanitize("<script><!--alert(1)--></script>")),
      ).toBe(false);
    });
  });

  describe("event handler injection on HTML elements", () => {
    it("rejects img onerror handler", () => {
      expect(
        isDangerous(DOMPurify.sanitize('<img src=x onerror="alert(1)">')),
      ).toBe(false);
    });

    it("rejects body onload handler", () => {
      expect(isDangerous(DOMPurify.sanitize('<body onload="alert(1)">'))).toBe(
        false,
      );
    });

    it("rejects svg onload handler", () => {
      expect(isDangerous(DOMPurify.sanitize('<svg onload="alert(1)">'))).toBe(
        false,
      );
    });

    it("rejects input autofocus onfocus", () => {
      expect(
        isDangerous(DOMPurify.sanitize('<input autofocus onfocus="alert(1)">')),
      ).toBe(false);
    });

    it("rejects marquee onstart handler", () => {
      expect(
        isDangerous(
          DOMPurify.sanitize('<marquee onstart="alert(1)">text</marquee>'),
        ),
      ).toBe(false);
    });
  });

  describe("javascript: URI scheme", () => {
    it("rejects anchor with javascript: href", () => {
      const out = DOMPurify.sanitize('<a href="javascript:alert(1)">click</a>');
      expect(isDangerous(out)).toBe(false);
      // The link should be stripped or the href should be removed.
      expect(out.toLowerCase()).not.toContain("javascript:");
    });

    it("rejects javascript: with tab obfuscation", () => {
      const out = DOMPurify.sanitize(
        '<a href="java\tscript:alert(1)">click</a>',
      );
      expect(out.toLowerCase()).not.toContain("javascript:");
    });

    it("rejects img src javascript:", () => {
      const out = DOMPurify.sanitize('<img src="javascript:alert(1)">');
      expect(out.toLowerCase()).not.toContain("javascript:");
    });
  });

  describe("iframe injection", () => {
    it("rejects iframe with src", () => {
      const out = DOMPurify.sanitize(
        '<iframe src="http://evil.example"></iframe>',
      );
      expect(out.toLowerCase()).not.toContain("<iframe");
    });

    it("rejects iframe with srcdoc", () => {
      const out = DOMPurify.sanitize(
        '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      );
      expect(out.toLowerCase()).not.toContain("<iframe");
    });
  });

  describe("SVG-based injection", () => {
    it("rejects SVG with embedded script element", () => {
      expect(
        isDangerous(DOMPurify.sanitize("<svg><script>alert(1)</script></svg>")),
      ).toBe(false);
    });

    it("rejects SVG use element href with javascript:", () => {
      const out = sanitizeHtml('<svg><use href="javascript:alert(1)"/></svg>');
      expect(out.toLowerCase()).not.toContain("javascript:");
    });
  });

  describe("data: URI injection", () => {
    it("rejects anchor with data:text/html href", () => {
      const out = DOMPurify.sanitize(
        '<a href="data:text/html,<script>alert(1)</script>">click</a>',
      );
      // DOMPurify strips data: URIs in href by default.
      expect(out.toLowerCase()).not.toContain("data:text/html");
    });
  });

  describe("CSS expression injection (IE legacy)", () => {
    it("cannot activate a legacy CSS expression in the browser CSSOM", () => {
      const out = DOMPurify.sanitize(
        '<div style="width:expression(alert(1))">x</div>',
      );
      const container = document.createElement("div");
      container.innerHTML = out;

      expect(container.querySelector("div")?.style.width).toBe("");
    });
  });

  describe("null-byte and control-character evasion", () => {
    it("rejects null byte injection around script tag", () => {
      const out = DOMPurify.sanitize("<scr\x00ipt>alert(1)</scr\x00ipt>");
      expect(isDangerous(out)).toBe(false);
    });
  });

  describe("template and custom-element boundaries", () => {
    it("removes template expressions in SAFE_FOR_TEMPLATES mode", () => {
      const out = DOMPurify.sanitize(
        "<p>{{constructor.constructor('alert(1)')()}}</p><p>${unsafe}</p>",
        { SAFE_FOR_TEMPLATES: true },
      );

      expect(out).not.toContain("{{");
      expect(out).not.toContain("${");
      expect(isDangerous(out)).toBe(false);
    });

    it("removes a custom-element payload while retaining its text", () => {
      const out = DOMPurify.sanitize(
        '<myoxus-card data-id="safe" onclick="alert(1)">text</myoxus-card>',
      );

      expect(out).toBe("text");
      expect(isDangerous(out)).toBe(false);
    });
  });

  describe("configuration and realm isolation", () => {
    it("ignores inherited configuration properties", () => {
      const inherited = { ADD_ATTR: ["onerror"] };
      const config = Object.create(inherited) as Record<string, unknown>;
      const out = DOMPurify.sanitize(
        '<img src="x" onerror="alert(1)">',
        config,
      );

      expect(isDangerous(out)).toBe(false);
    });

    it("sanitizes markup originating in a separate document realm", () => {
      const foreignDocument = document.implementation.createHTMLDocument();
      const node = foreignDocument.createElement("section");
      node.innerHTML =
        '<svg onload="alert(1)"><a href="javascript:alert(2)">x</a></svg>';

      const sanitized = sanitizeHtml(node.outerHTML);

      expect(isDangerous(sanitized)).toBe(false);
    });

    it("does not let named form controls pollute later sanitization", () => {
      DOMPurify.sanitize(
        '<form><input name="__proto__"><input name="constructor"></form>',
      );

      const later = DOMPurify.sanitize(
        '<img src="x" onerror="alert(1)"><p>safe</p>',
      );
      expect(isDangerous(later)).toBe(false);
      expect(later).toContain("<p>safe</p>");
    });
  });
});

describe("DOMPurify — safe content passes through unchanged", () => {
  it("preserves standard block elements and text", () => {
    const safe = "<p>Hello <strong>world</strong>!</p><ul><li>item</li></ul>";
    const out = sanitizeHtml(safe);
    expect(out).toContain("<p>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>");
  });

  it("preserves safe external links", () => {
    const safe = '<a href="https://example.com" target="_blank">link</a>';
    const out = sanitizeHtml(safe);
    expect(out).toContain('href="https://example.com"');
  });

  it("preserves safe images with https src", () => {
    const safe = '<img src="https://example.com/img.png" alt="img">';
    const out = sanitizeHtml(safe);
    expect(out).toContain("<img");
    expect(out).toContain('alt="img"');
  });

  it("preserves headings and inline code", () => {
    const safe = "<h2>Title</h2><p>See <code>foo()</code>.</p>";
    const out = sanitizeHtml(safe);
    expect(out).toContain("<h2>");
    expect(out).toContain("<code>");
  });
});

describe("DOMPurify — in-place boundary", () => {
  it("sanitizes a current-realm node without replacing it", () => {
    const node = document.createElement("section");
    node.innerHTML = '<img src="x" onerror="alert(1)">';

    const sanitized = DOMPurify.sanitize(node, {
      FORBID_TAGS: ["svg", "use"],
      IN_PLACE: true,
      USE_PROFILES: { html: true },
    });

    expect(sanitized).toBe(node);
    expect(isDangerous(node.outerHTML)).toBe(false);
  });
});
