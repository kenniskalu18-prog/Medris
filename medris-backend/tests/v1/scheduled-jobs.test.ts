import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, call } from "../support/fixtures.js";
import { createTestDatabase, type TestDatabase } from "../support/test-db.js";

describe("/api/v1/jobs", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildTestApp>;
  const secret = "test-cron-secret";

  beforeAll(async () => {
    db = await createTestDatabase();
    app = buildTestApp(db);
  });
  afterAll(() => db.close());
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("fails closed: without CRON_SECRET configured nobody can run a job", async () => {
    const res = await call(app, "POST", "/api/v1/jobs/remind-unattended-orders");
    expect(res.status).toBe(503);
  });

  const withSecret = (value = secret) => ({ headers: { "x-cron-secret": value } });

  it("needs the secret in x-cron-secret", async () => {
    process.env.CRON_SECRET = secret;
    expect((await call(app, "POST", "/api/v1/jobs/remind-unattended-orders")).status).toBe(401);
    expect((await call(app, "POST", "/api/v1/jobs/remind-unattended-orders", withSecret("wrong"))).status).toBe(401);
    expect((await call(app, "POST", "/api/v1/jobs/remind-unattended-orders", { token: secret })).status).toBe(401);
    const ran = await call(app, "POST", "/api/v1/jobs/remind-unattended-orders", withSecret());
    expect(ran.status).toBe(200);
    expect(await ran.json()).toEqual({ data: { job: "remind-unattended-orders", result: 0 } });
  });

  it("lists every pg_cron job and refuses unknown ones", async () => {
    process.env.CRON_SECRET = secret;
    const list = await call(app, "GET", "/api/v1/jobs", withSecret());
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as { data: { name: string; schedule: string }[] };
    expect(data).toHaveLength(9);
    expect(data).toContainEqual(expect.objectContaining({ name: "bg-reminders", schedule: "* * * * *" }));
    expect((await call(app, "POST", "/api/v1/jobs/drop-everything", withSecret())).status).toBe(400);
  });
});
