import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimited } from "@/components/rate-limited";
import { PUBLIC_LIMIT_PER_MINUTE, allowPublicRequest, resetPublicLimiter } from "@/lib/ip-limit";

const searchPublished = vi.fn(async () => ({ articles: [], hasMore: false, nextOffset: null }));
const getPublished = vi.fn(async () => {
  throw new Error("not found");
});
vi.mock("@/lib/kb", () => ({ searchPublished, getPublished }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }),
}));

const apiGet = async (ip: string) => {
  const { GET } = await import("../api/kb/route");
  return GET(new Request("http://x/api/kb?q=billing", { headers: { "x-forwarded-for": `1.2.3.4, ${ip}` } }));
};

describe("public KB per-IP limit", () => {
  beforeEach(() => {
    resetPublicLimiter();
    searchPublished.mockClear();
    getPublished.mockClear();
  });

  it("GET /api/kb answers 60 requests per minute per IP, then 429 with Retry-After and no search", async () => {
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) expect((await apiGet("8.8.8.8")).status).toBe(200);
    const limited = await apiGet("8.8.8.8");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "Too many requests" });
    expect(searchPublished).toHaveBeenCalledTimes(PUBLIC_LIMIT_PER_MINUTE);
    expect((await apiGet("9.9.9.9")).status).toBe(200); // another address is unaffected
  });

  it("the /kb page renders the too-many-requests state and never searches", async () => {
    const { default: Page } = await import("./page");
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) allowPublicRequest("7.7.7.7"); // the last entry is the key
    const el = await Page({ searchParams: Promise.resolve({}) });
    expect(el.type).toBe(RateLimited);
    expect(searchPublished).not.toHaveBeenCalled();
  });

  it("the article page does the same and does not look the article up, even for its metadata", async () => {
    const { default: Page, generateMetadata } = await import("./[slug]/page");
    for (let i = 0; i < PUBLIC_LIMIT_PER_MINUTE; i++) allowPublicRequest("7.7.7.7");
    const el = await Page({ params: Promise.resolve({ slug: "billing" }) });
    expect(el.type).toBe(RateLimited);
    expect(await generateMetadata({ params: Promise.resolve({ slug: "billing" }) })).toEqual({ title: "Help article" });
    expect(getPublished).not.toHaveBeenCalled();
  });

  it("the page shares the API's bucket and under the limit the search runs", async () => {
    const { default: Page } = await import("./page");
    await Page({ searchParams: Promise.resolve({}) });
    expect(searchPublished).toHaveBeenCalledTimes(1);
  });
});
