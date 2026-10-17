import pg from "pg";

/**
 * Where row-change announcements come from: PostgreSQL LISTEN on the channel the
 * backend_live_notify() trigger (migration 0004) NOTIFYs. Returns a function that stops listening.
 */
export interface ChangeSource {
  listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
}

/**
 * One dedicated connection (LISTEN cannot go through a pool or a transaction pooler: use the database's direct or
 * session-mode URL). Reconnects with a growing pause when the connection drops; changes committed while it was
 * down are not replayed, the same as Supabase Realtime - clients refetch when they reconnect.
 */
export class PgChangeSource implements ChangeSource {
  constructor(
    private readonly connection: pg.ClientConfig,
    private readonly onState: (state: "connected" | "disconnected", error?: unknown) => void = () => {},
  ) {}

  async listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>> {
    if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error("Invalid channel name.");
    let client: pg.Client | null = null;
    let stopped = false;
    let delay = 1000;
    let timer: NodeJS.Timeout | null = null;
    const connect = async (): Promise<void> => {
      const c = new pg.Client(this.connection);
      c.on("notification", (n) => {
        if (n.channel === channel) onMessage(n.payload ?? "");
      });
      c.on("error", (err) => retry(err));
      c.on("end", () => retry());
      await c.connect();
      await c.query(`listen ${channel}`);
      client = c;
      delay = 1000;
      this.onState("connected");
    };
    const retry = (err?: unknown) => {
      if (stopped || timer) return;
      client = null;
      this.onState("disconnected", err);
      timer = setTimeout(() => {
        timer = null;
        connect().catch((e) => retry(e));
      }, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    await connect();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await (client as pg.Client | null)?.end().catch(() => {});
    };
  }
}
