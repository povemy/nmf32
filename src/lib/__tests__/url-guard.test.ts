// bun:test — URL guard (Task D2). No DB, no Next runtime: pure module.
import { describe, expect, test } from "bun:test";
import { sanitizeExternalUrl, isSafeExternalUrl } from "../url-guard";

describe("sanitizeExternalUrl — http(s) pass-through", () => {
  test("bare domain https normalizes with trailing slash", () => {
    expect(sanitizeExternalUrl("https://example.com")).toBe("https://example.com/");
  });

  test("http with port and path", () => {
    expect(sanitizeExternalUrl("http://example.com:8080/shop")).toBe("http://example.com:8080/shop");
  });

  test("https with path, query and fragment survives normalized", () => {
    expect(sanitizeExternalUrl("https://example.com/p/q?utm=x&b=2#frag")).toBe(
      "https://example.com/p/q?utm=x&b=2#frag"
    );
  });

  test("surrounding whitespace is trimmed, not fatal", () => {
    expect(sanitizeExternalUrl("  https://example.com/a  ")).toBe("https://example.com/a");
  });

  test("mixed-case scheme is normalized to lowercase", () => {
    expect(sanitizeExternalUrl("HTTPS://EXAMPLE.COM/x")).toBe("https://example.com/x");
  });
});

describe("sanitizeExternalUrl — dangerous schemes rejected", () => {
  test("javascript: URI", () => {
    expect(sanitizeExternalUrl("javascript:alert(1)")).toBeNull();
  });

  test("mixed-case JaVaScRiPt: URI", () => {
    expect(sanitizeExternalUrl("JaVaScRiPt:alert(document.cookie)")).toBeNull();
  });

  test("data: URI", () => {
    expect(sanitizeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  test("file: URI", () => {
    expect(sanitizeExternalUrl("file:///etc/passwd")).toBeNull();
  });

  test("vbscript: URI", () => {
    expect(sanitizeExternalUrl("vbscript:msgbox")).toBeNull();
  });

  test("HTML-entity-obfuscated javascript&#58; raw string fails URL parse", () => {
    expect(sanitizeExternalUrl("javascript&#58;alert(1)")).toBeNull();
  });

  test("whitespace-smuggled javascript scheme fails", () => {
    expect(sanitizeExternalUrl("javascript\n:alert(1)")).toBeNull();
  });

  test("scheme-less garbage fails URL parse", () => {
    expect(sanitizeExternalUrl("not a url at all")).toBeNull();
  });

  test("https:// with no host fails URL parse", () => {
    expect(sanitizeExternalUrl("https://")).toBeNull();
  });
});

describe("sanitizeExternalUrl — credentials & length", () => {
  test("user:pass credentials rejected", () => {
    expect(sanitizeExternalUrl("https://u:p@example.com/")).toBeNull();
  });

  test("username-only credentials rejected", () => {
    expect(sanitizeExternalUrl("http://alice@evil.com/")).toBeNull();
  });

  test("maxLength exceeded → null", () => {
    const long = `https://example.com/${"a".repeat(600)}`;
    expect(sanitizeExternalUrl(long)).toBeNull();
  });

  test("custom maxLength is honored", () => {
    expect(sanitizeExternalUrl("https://example.com/abcdef", { maxLength: 10 })).toBeNull();
    expect(sanitizeExternalUrl("https://example.com/abcdef", { maxLength: 50 })).toBe(
      "https://example.com/abcdef"
    );
  });
});

describe("sanitizeExternalUrl — absent / blank input", () => {
  test("undefined → null", () => {
    expect(sanitizeExternalUrl(undefined)).toBeNull();
  });

  test("null → null", () => {
    expect(sanitizeExternalUrl(null)).toBeNull();
  });

  test("empty string → null", () => {
    expect(sanitizeExternalUrl("")).toBeNull();
  });

  test("whitespace-only string → null", () => {
    expect(sanitizeExternalUrl("   \t ")).toBeNull();
  });
});

describe("sanitizeExternalUrl — allowRelative option", () => {
  test("site-relative path passes only with allowRelative", () => {
    expect(sanitizeExternalUrl("/uploads/x.png")).toBeNull();
    expect(sanitizeExternalUrl("/uploads/x.png", { allowRelative: true })).toBe("/uploads/x.png");
  });

  test("relative path with query + fragment passes through verbatim", () => {
    expect(sanitizeExternalUrl("/api/img/x?w=600&h=600#top", { allowRelative: true })).toBe(
      "/api/img/x?w=600&h=600#top"
    );
  });

  test("protocol-relative //evil.com rejected even with allowRelative", () => {
    expect(sanitizeExternalUrl("//evil.com/x", { allowRelative: true })).toBeNull();
  });

  test("backslash smuggling /\\evil.com rejected", () => {
    expect(sanitizeExternalUrl("/\\evil.com/x", { allowRelative: true })).toBeNull();
  });

  test("no leading slash (uploads/x.png) rejected even with allowRelative", () => {
    expect(sanitizeExternalUrl("uploads/x.png", { allowRelative: true })).toBeNull();
  });

  test("absolute http(s) still validated (not bypassed) with allowRelative", () => {
    expect(sanitizeExternalUrl("javascript:alert(1)", { allowRelative: true })).toBeNull();
    expect(sanitizeExternalUrl("https://u:p@x.com/", { allowRelative: true })).toBeNull();
    expect(sanitizeExternalUrl("https://ok.com/x", { allowRelative: true })).toBe("https://ok.com/x");
  });

  test("control characters inside a relative path rejected", () => {
    expect(sanitizeExternalUrl("/uploads/\u0000evil.png", { allowRelative: true })).toBeNull();
  });
});

describe("isSafeExternalUrl — consistent with sanitizeExternalUrl", () => {
  const cases: Array<[string, boolean]> = [
    ["https://example.com/x", true],
    ["http://example.com", true],
    ["javascript:alert(1)", false],
    ["JaVaScRiPt:alert(1)", false],
    ["data:text/html,x", false],
    ["file:///etc/passwd", false],
    ["vbscript:msgbox", false],
    ["javascript&#58;alert(1)", false],
    ["https://u:p@example.com/", false],
    ["", false],
    ["   ", false],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(isSafeExternalUrl(input)).toBe(expected);
      expect(isSafeExternalUrl(input) === (sanitizeExternalUrl(input) != null)).toBe(true);
    });
  }

  test("undefined/null → false", () => {
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
  });

  test("opts are forwarded (allowRelative)", () => {
    expect(isSafeExternalUrl("/uploads/x.png")).toBe(false);
    expect(isSafeExternalUrl("/uploads/x.png", { allowRelative: true })).toBe(true);
    expect(isSafeExternalUrl("//evil.com/x", { allowRelative: true })).toBe(false);
  });
});
