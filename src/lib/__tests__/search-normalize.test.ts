// ============================================================================
// PHASE 2.1 (§9-B) — search-query normalization tests (bun:test, pure).
// The normalizer is the cache-key cardinality guard for every public search
// surface (market products, sf products, suggest).
// ============================================================================
import { describe, expect, test } from "bun:test";
import { MAX_SEARCH_QUERY_CHARS, normalizeSearchQuery } from "@/lib/search-normalize";

describe("normalizeSearchQuery", () => {
  test("trims and collapses repeated whitespace", () => {
    expect(normalizeSearchQuery("  wireless   earbuds ")).toBe("wireless earbuds");
    expect(normalizeSearchQuery("\ttabs\tand\nnewlines")).toBe("tabs and newlines");
  });

  test("empty / whitespace-only / null / undefined → empty string", () => {
    expect(normalizeSearchQuery("")).toBe("");
    expect(normalizeSearchQuery("    ")).toBe("");
    expect(normalizeSearchQuery(null)).toBe("");
    expect(normalizeSearchQuery(undefined)).toBe("");
  });

  test("control characters are stripped (cache-key injection junk)", () => {
    expect(normalizeSearchQuery("\u0000\u001fabc\u007f")).toBe("abc");
  });

  test("over-length input is capped, never keyed at full length", () => {
    const long = "a".repeat(MAX_SEARCH_QUERY_CHARS + 500);
    expect(normalizeSearchQuery(long)).toBe("a".repeat(MAX_SEARCH_QUERY_CHARS));
  });

  test("case is PRESERVED (titles are cased; server matching is insensitive)", () => {
    expect(normalizeSearchQuery("Sony WH-1000XM5")).toBe("Sony WH-1000XM5");
  });

  test("identical user intent collapses to ONE cache key", () => {
    expect(normalizeSearchQuery("head phones")).toBe("head phones");
    expect(normalizeSearchQuery("  HEAD   PHONES ")).toBe("HEAD PHONES"); // case kept, spaces collapsed
    expect(normalizeSearchQuery("head\u0001phones")).toBe("headphones"); // control junk dropped → distinct key
  });
});
