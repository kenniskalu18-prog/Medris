import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileBucket } from "../../src/database/repositories/storage-access.repository.js";
import { FilesService, type BucketClient } from "../../src/modules/files/files.service.js";
import { accessToken, buildTestApp, call, seedUser, seedVendor, setRole } from "../support/fixtures.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

/** /api/v1/files: the checks happen before Storage is touched; a fake bucket records what reached it. */
describe("/api/v1/files", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildTestApp>;
  let buyer: string;
  let admin: string;
  let owner: string;
  let shop: string;
  const calls: string[] = [];

  const fake = (name: FileBucket): BucketClient => ({
    createDirectUpload: async (key, _type, options) => {
      calls.push(`upload ${name}/${key}${options?.upsert ? " upsert" : ""}`);
      return { uploadUrl: `https://storage.test/${name}/${key}?token=t`, method: "PUT", expiresInSeconds: 7200 };
    },
    signedUrls: async (keys, expires) => {
      calls.push(`sign ${name} ${keys.length} ${expires}`);
      return keys.map((path) => ({ path, signedUrl: `https://storage.test/${name}/${path}?sig=s` }));
    },
    remove: async (keys) => void calls.push(`remove ${name} ${keys.join(",")}`),
    publicUrl: (key) => `https://storage.test/public/${name}/${key}`,
    listEntries: async (prefix) => [{ name: `${prefix || "top"}-file.jpg`, folder: false }],
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildTestApp(db, { services: { files: new FilesService(() => db.data, fake) } });
    buyer = (await seedUser(db)).id;
    admin = (await seedUser(db)).id;
    await setRole(db, admin, "admin");
    owner = (await seedUser(db, { role: "vendor" })).id;
    shop = (await seedVendor(db, owner)).id;
  }, 60_000);
  afterAll(() => db.close());

  const as = async (id: string) => ({ token: await accessToken(id) });

  it("upload link: own folder only; public buckets also get the public URL; upsert passed through", async () => {
    const ok = await call(app, "POST", "/api/v1/files/upload-links", { ...(await as(buyer)), body: { bucket: "vendor-docs", path: `${buyer}/id.jpg`, contentType: "image/jpeg" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { uploadUrl: string } }).data.uploadUrl).toContain(`vendor-docs/${buyer}/id.jpg`);
    const forged = await call(app, "POST", "/api/v1/files/upload-links", { ...(await as(buyer)), body: { bucket: "vendor-docs", path: `${owner}/id.jpg`, contentType: "image/jpeg" } });
    expect(forged.status).toBe(403);
    const photo = await call(app, "POST", "/api/v1/files/upload-links", { ...(await as(owner)), body: { bucket: "product-photos", path: `${shop}/p.jpg`, contentType: "image/jpeg", upsert: true } });
    expect(((await photo.json()) as { data: { publicUrl: string } }).data.publicUrl).toBe(`https://storage.test/public/product-photos/${shop}/p.jpg`);
    expect(calls).toEqual([`upload vendor-docs/${buyer}/id.jpg`, `upload product-photos/${shop}/p.jpg upsert`]);
  });

  it("needs sign-in to upload or delete; bad paths are 400", async () => {
    expect((await call(app, "POST", "/api/v1/files/upload-links", { body: { bucket: "avatars", path: "x/a.jpg", contentType: "image/jpeg" } })).status).toBe(401);
    expect((await call(app, "POST", "/api/v1/files/delete", { body: { bucket: "avatars", paths: ["x/a.jpg"] } })).status).toBe(401);
    expect((await call(app, "POST", "/api/v1/files/upload-links", { ...(await as(buyer)), body: { bucket: "avatars", path: `${buyer}/../x.jpg`, contentType: "image/jpeg" } })).status).toBe(400);
    expect((await call(app, "POST", "/api/v1/files/upload-links", { ...(await as(buyer)), body: { bucket: "champion-cvs", path: `${buyer}/x.pdf`, contentType: "application/pdf" } })).status).toBe(400);
  });

  it("signed links: only when every file may be read (admins read vendor documents)", async () => {
    calls.length = 0;
    const mine = await call(app, "POST", "/api/v1/files/signed-urls", { ...(await as(owner)), body: { bucket: "vendor-docs", paths: [`${owner}/id.jpg`], expiresIn: 300 } });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ data: [{ path: `${owner}/id.jpg`, signedUrl: `https://storage.test/vendor-docs/${owner}/id.jpg?sig=s` }] });
    expect((await call(app, "POST", "/api/v1/files/signed-urls", { ...(await as(admin)), body: { bucket: "vendor-docs", paths: [`${owner}/id.jpg`, `${buyer}/id.jpg`] } })).status).toBe(200);
    expect((await call(app, "POST", "/api/v1/files/signed-urls", { ...(await as(buyer)), body: { bucket: "vendor-docs", paths: [`${buyer}/id.jpg`, `${owner}/id.jpg`] } })).status).toBe(403);
    expect((await call(app, "POST", "/api/v1/files/signed-urls", { body: { bucket: "vendor-docs", paths: [`${owner}/id.jpg`] } })).status).toBe(403);
    expect(calls).toEqual(["sign vendor-docs 1 300", "sign vendor-docs 2 3600"]);
  });

  it("delete: own files; chat attachments can never be deleted", async () => {
    calls.length = 0;
    expect((await call(app, "POST", "/api/v1/files/delete", { ...(await as(buyer)), body: { bucket: "avatars", paths: [`${buyer}/avatar.jpg`, `${buyer}/avatar.png`] } })).status).toBe(200);
    expect((await call(app, "POST", "/api/v1/files/delete", { ...(await as(buyer)), body: { bucket: "avatars", paths: [`${owner}/avatar.jpg`] } })).status).toBe(403);
    expect((await call(app, "POST", "/api/v1/files/delete", { ...(await as(admin)), body: { bucket: "chat-attachments", paths: [`ai/${admin}/a.jpg`] } })).status).toBe(403);
    expect(calls).toEqual([`remove avatars ${buyer}/avatar.jpg,${buyer}/avatar.png`]);
  });

  it("list: public buckets only", async () => {
    const res = await call(app, "POST", "/api/v1/files/list", { body: { bucket: "product-photos", prefix: shop } });
    expect(await res.json()).toEqual({ data: [{ name: `${shop}-file.jpg`, folder: false }] });
    expect((await call(app, "POST", "/api/v1/files/list", { ...(await as(admin)), body: { bucket: "vendor-docs" } })).status).toBe(403);
  });
});
