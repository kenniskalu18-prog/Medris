import { describe, expect, it } from "vitest";
import { SupabaseStorage } from "../../src/integrations/storage/supabase.storage.js";

/** The Storage HTTP calls the files endpoints make (no network: fetch is recorded and answered). */
describe("SupabaseStorage", () => {
  const recorder = (answer: unknown) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, storage: new SupabaseStorage("vendor-docs", "https://p.supabase.co", "service", doFetch) };
  };

  it("signs read links in one call; files that do not exist get null", async () => {
    const { seen, storage } = recorder([
      { path: "u/a.jpg", signedURL: "/object/sign/vendor-docs/u/a.jpg?token=t", error: null },
      { path: "u/b.jpg", signedURL: null, error: "Either the object does not exist or you do not have access to it" },
    ]);
    expect(await storage.signedUrls(["u/a.jpg", "u/b.jpg"], 300)).toEqual([
      { path: "u/a.jpg", signedUrl: "https://p.supabase.co/storage/v1/object/sign/vendor-docs/u/a.jpg?token=t" },
      { path: "u/b.jpg", signedUrl: null },
    ]);
    expect(seen[0]!.url).toBe("https://p.supabase.co/storage/v1/object/sign/vendor-docs");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ expiresIn: 300, paths: ["u/a.jpg", "u/b.jpg"] });
    await expect(storage.signedUrls(["../x"], 60)).rejects.toThrow("Invalid storage key.");
  });

  it("an upsert upload link is signed with x-upsert", async () => {
    const { seen, storage } = recorder({ url: "/object/upload/sign/vendor-docs/u/a.jpg?token=t" });
    await storage.createDirectUpload("u/a.jpg", "image/jpeg", { upsert: true });
    expect((seen[0]!.init.headers as Record<string, string>)["x-upsert"]).toBe("true");
    await storage.createDirectUpload("u/a.jpg", "image/jpeg");
    expect((seen[1]!.init.headers as Record<string, string>)["x-upsert"]).toBeUndefined();
  });

  it("lists one level, marking folders (no id)", async () => {
    const { storage } = recorder([{ name: "shop1", id: null }, { name: "a.jpg", id: "x" }]);
    expect(await storage.listEntries("")).toEqual([
      { name: "shop1", folder: true },
      { name: "a.jpg", folder: false },
    ]);
  });
});
