import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/database/client.js";
import { rowsOf } from "../../src/database/client.js";
import { DataContext } from "../../src/database/context.js";
import { CartRepository } from "../../src/database/repositories/cart.repository.js";
import { AuthAccountsRepository } from "../../src/database/repositories/users.repository.js";
import * as schema from "../../src/database/schema/index.js";
import { createPglite, schemaSql } from "../support/test-db.js";

/**
 * Migration 0001: the backend connects as `medris_api`, a login role with no
 * table rights of its own. Everything must still work through the API roles,
 * and the role may read only the granted auth.users columns.
 */
describe("least-privilege connection role (migration 0001)", () => {
  let data: DataContext;
  let close: () => Promise<void>;
  let exec: (text: string) => Promise<void>;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (url) {
      const name = `${new URL(url).pathname.slice(1)}_lp${Date.now().toString(36)}`;
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query(`create database "${name}"`);
      await admin.end();
      const ownerUrl = new URL(url);
      ownerUrl.pathname = `/${name}`;
      const owner = new pg.Pool({ connectionString: ownerUrl.toString() });
      for (const chunk of schemaSql()) await owner.query(chunk).catch(async (err: { code?: string }) => {
        if (err.code === "23505" || err.code === "42710") return;
        throw err;
      });
      exec = async (text) => void (await owner.query(text));
      // Servers that require passwords (e.g. the postgres:17 image in CI) refuse a login without
      // one, so give the role a throwaway password on this test server (roles are server-wide).
      const password = crypto.randomUUID();
      await owner.query(`alter role medris_api with password '${password}'`);
      const apiUrl = new URL(ownerUrl.toString());
      apiUrl.username = "medris_api";
      apiUrl.password = password;
      const api = new pg.Pool({ connectionString: apiUrl.toString() });
      data = new DataContext(drizzlePg(api, { schema }) as unknown as Db);
      close = async () => {
        await api.end();
        await owner.end();
        const cleanup = new pg.Client({ connectionString: url });
        await cleanup.connect();
        await cleanup.query(`drop database if exists "${name}" with (force)`);
        await cleanup.end();
      };
    } else {
      const client = createPglite();
      for (const chunk of schemaSql()) await client.exec(chunk);
      exec = async (text) => void (await client.exec(text));
      await exec(`
        insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
        values ('00000000-0000-4000-8000-000000000001', 'lp@example.com', '$2a$04$x', now(), '{"secret":1}');`);
      // Become medris_api for the rest of this connection (PGlite has a single connection).
      await client.exec("set session authorization medris_api");
      data = new DataContext(drizzlePglite(client, { schema }) as unknown as Db);
      close = () => client.close();
    }
  }, 120_000);
  afterAll(async () => close?.());

  it("connects with no table privileges of its own", async () => {
    const who = await data.db.execute(sql`select current_user::text as u, has_table_privilege('public.cart_items', 'select') as can`);
    expect(rowsOf<{ u: string; can: boolean }>(who)[0]).toEqual({ u: "medris_api", can: false });
  });

  it("still serves user requests through the authenticated role and RLS", async () => {
    const userId = "00000000-0000-4000-8000-0000000000aa";
    const items = await data.asUser({ userId, email: null, claims: {}, source: "supabase-jwt" }, (tx) => new CartRepository(tx).listForBuyer(userId));
    expect(items).toEqual([]);
    const role = await data.asService(async (tx) => rowsOf<{ u: string }>(await tx.execute(sql`select current_user::text as u`))[0]?.u);
    expect(role).toBe("service_role");
  });

  it("reads only the granted auth.users columns", async () => {
    if (process.env.TEST_DATABASE_URL) {
      await exec(`insert into auth.users (id, email, encrypted_password, email_confirmed_at) values ('00000000-0000-4000-8000-000000000001', 'lp@example.com', '$2a$04$x', now()) on conflict do nothing`);
    }
    const account = await data.asAuthReader((tx) => new AuthAccountsRepository(tx).findByEmail("LP@example.com"));
    expect(account).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", encryptedPassword: "$2a$04$x" });
    await expect(data.asAuthReader((tx) => tx.execute(sql`select raw_user_meta_data from auth.users`))).rejects.toThrow();
  });
});
