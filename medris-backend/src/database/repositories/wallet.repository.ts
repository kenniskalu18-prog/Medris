import { sql } from "drizzle-orm";
import type { Executor } from "../client.js";
import { jsonReturning, jsonRow, jsonRows } from "../json.js";

export interface WalletAccount {
  user_id: string;
  handle: string;
  balance_kobo: string;
  frozen: boolean;
  frozen_reason: string | null;
  handle_changed_at: string | null;
}
export interface WalletPerson {
  user_id: string;
  handle: string;
  name: string | null;
  avatar_url: string | null;
  frozen: boolean;
}
export interface WithdrawalAccount {
  source: "shop" | "buyer";
  recipient_code: string;
  bank_name: string | null;
  account_name: string | null;
  last4: string | null;
  verified_at: string;
  age_hours: number;
}
export interface WalletWithdrawal {
  id: string;
  user_id: string;
  amount_kobo: string;
  status: string;
  review_reason: string | null;
  fee_kobo: string;
  transfer_reference: string;
  recipient_code: string | null;
  bank_name: string | null;
  account_name: string | null;
  account_last4: string | null;
  reject_reason: string | null;
  created_at: string;
}
export type Kind = "topup" | "transfer_in" | "transfer_out" | "order_payment" | "refund_in" | "refund_out" | "earnings_in" | "withdrawal" | "withdrawal_return" | "fee" | "fee_return" | "points_in";

/** The Levromart wallet (migration 0033): balances, the ledger, transfers and bank withdrawals. Service role only. */
export class WalletRepository {
  constructor(private readonly db: Executor) {}

  /** The person's wallet, created on first use (with an @tag made from their name). */
  async ensure(userId: string): Promise<WalletAccount | null> {
    await this.db.execute(sql`
      insert into public.wallet_accounts (user_id, handle)
      select u.id, public.wallet_make_handle(u.name, u.id) from public.users u where u.id = ${userId}
      on conflict do nothing`);
    return this.account(userId);
  }

  account(userId: string): Promise<WalletAccount | null> {
    return jsonRow<WalletAccount>(this.db, sql`select user_id, handle, balance_kobo::text as balance_kobo, frozen, frozen_reason, handle_changed_at from public.wallet_accounts where user_id = ${userId}`);
  }

  /** Locks the wallets in a fixed order (by user id), so two transfers between the same people can never deadlock. */
  async lock(userIds: string[]): Promise<WalletAccount[]> {
    const list = [...new Set(userIds)].sort();
    return jsonRows<WalletAccount>(
      this.db,
      sql`select user_id, handle, balance_kobo::text as balance_kobo, frozen, frozen_reason, handle_changed_at from public.wallet_accounts
          where user_id in (${sql.join(list.map((x) => sql`${x}::uuid`), sql`, `)}) order by user_id for update`,
    );
  }

  person(handle: string): Promise<WalletPerson | null> {
    return jsonRow<WalletPerson>(
      this.db,
      sql`select w.user_id, w.handle, u.name, u.avatar_url, w.frozen from public.wallet_accounts w join public.users u on u.id = w.user_id
          where w.handle = ${handle} and u.suspended_at is null`,
    );
  }

  /** People whose @tag starts with what was typed (never by name, so nobody can be found without their @tag). */
  /** People by any part of their @tag or any word of their name ("query" finds "Bankole Korede"); the @tag that starts with it comes first. */
  search(query: string, exceptUserId: string, limit = 8): Promise<WalletPerson[]> {
    const esc = (t: string) => t.replace(/[\\%_]/g, (c) => "\\" + c);
    const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
    const conds = words.map((w) => sql`(w.handle like ${"%" + esc(w) + "%"} or lower(u.name) like ${"%" + esc(w) + "%"})`);
    const first = esc(words[0] ?? "");
    return jsonRows<WalletPerson>(
      this.db,
      sql`select w.user_id, w.handle, u.name, u.avatar_url, w.frozen from public.wallet_accounts w join public.users u on u.id = w.user_id
          where ${sql.join(conds, sql` and `)} and w.user_id <> ${exceptUserId} and u.suspended_at is null and u.role <> 'admin'
          order by (w.handle like ${first + "%"}) desc, (lower(u.name) like ${first + "%"} or lower(u.name) like ${"% " + first + "%"}) desc, length(w.handle), w.handle limit ${limit}`,
    );
  }

  async emailOf(userId: string): Promise<string | null> {
    const r = await jsonRow<{ email: string | null }>(this.db, sql`select email from public.users where id = ${userId}`);
    const e = r?.email ?? null;
    // a phone sign-in uses a hidden alias address; Paystack still needs an email, and that one works for it
    return e && e.includes("@") ? e : null;
  }

  async handleTaken(handle: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.wallet_accounts where handle = ${handle}`)) !== null;
  }

  /** When the current run of @tag changes started and how many changes it holds (migration 0049). */
  async handleWindow(userId: string): Promise<{ start: string | null; n: number } | null> {
    return jsonRow(this.db, sql`select handle_window_start as start, handle_change_count as n from public.wallet_accounts where user_id = ${userId}`);
  }

  async setHandle(userId: string, handle: string, newWindow = true): Promise<void> {
    await this.db.execute(sql`update public.wallet_accounts set handle = ${handle}, handle_changed_at = now(),
      handle_window_start = case when ${newWindow} then now() else handle_window_start end,
      handle_change_count = case when ${newWindow} then 1 else handle_change_count + 1 end where user_id = ${userId}`);
  }

  async markRefundProcessed(id: string): Promise<void> {
    await this.db.execute(sql`update public.paystack_refunds set status = 'processed', last_error = null where id = ${id}`);
  }

  /** Marks a shop payout as moved into the wallet; false when it was not waiting (already moved or paid). */
  async payoutToWallet(payoutId: string, amountKobo: number, commissionKobo: number): Promise<boolean> {
    const rows = await jsonReturning<{ id: string }>(this.db, sql`
      update public.vendor_payouts set status = 'to_wallet', amount_kobo = ${amountKobo}, commission_kobo = ${commissionKobo}, hold_reason = null, withdrawal_id = null
      where id = ${payoutId} and status = 'on_hold' returning id`);
    return rows.length > 0;
  }

  async entryExists(userId: string, kind: Kind, reference: string): Promise<boolean> {
    return (await jsonRow(this.db, sql`select 1 as x from public.wallet_entries where user_id = ${userId} and kind = ${kind} and reference = ${reference}`)) !== null;
  }

  /**
   * Moves money in (positive) or out (negative) of one wallet and writes the ledger line, in one statement. Returns the
   * balance after it, or null when the wallet does not have enough (nothing is changed then). Call inside a transaction
   * that has locked the wallet.
   */
  async move(userId: string, amountKobo: number, kind: Kind, f: { reference?: string | null; note?: string | null; orderId?: string | null; counterpartyId?: string | null; transferId?: string | null; withdrawalId?: string | null } = {}): Promise<number | null> {
    const rows = await jsonReturning<{ balance_kobo: string }>(
      this.db,
      sql`update public.wallet_accounts set balance_kobo = balance_kobo + ${amountKobo}
          where user_id = ${userId} and balance_kobo + ${amountKobo} >= 0 returning balance_kobo::text as balance_kobo`,
    );
    if (!rows.length) return null;
    const after = rows[0]!.balance_kobo;
    await this.db.execute(sql`
      insert into public.wallet_entries (user_id, kind, amount_kobo, balance_after_kobo, reference, note, order_id, counterparty_id, transfer_id, withdrawal_id)
      values (${userId}, ${kind}, ${amountKobo}, ${after}::bigint, ${f.reference ?? null}, ${f.note ?? null}, ${f.orderId ?? null}::uuid, ${f.counterpartyId ?? null}::uuid, ${f.transferId ?? null}::uuid, ${f.withdrawalId ?? null}::uuid)`);
    return Number(after);
  }

  /** Money that arrived by top-up or transfer in the last `hours` (it cannot leave for the bank without an admin's check). */
  async recentInflowKobo(userId: string, hours = 24): Promise<number> {
    const r = await jsonRow<{ k: string }>(this.db, sql`select coalesce(sum(amount_kobo), 0)::text as k from public.wallet_entries where user_id = ${userId} and kind in ('topup', 'transfer_in') and created_at > now() - make_interval(hours => ${hours})`);
    return Number(r?.k ?? 0);
  }

  /** What this person sent to others in the last 24 hours. */
  async sentTodayKobo(userId: string): Promise<number> {
    const r = await jsonRow<{ k: string }>(this.db, sql`select coalesce(-sum(amount_kobo), 0)::text as k from public.wallet_entries where user_id = ${userId} and kind = 'transfer_out' and created_at > now() - interval '24 hours'`);
    return Number(r?.k ?? 0);
  }

  async withdrawalsToday(userId: string): Promise<number> {
    const r = await jsonRow<{ n: number }>(this.db, sql`select count(*)::int as n from public.wallet_withdrawals where user_id = ${userId} and created_at > now() - interval '24 hours' and status <> 'rejected'`);
    return r?.n ?? 0;
  }

  /** The ledger, newest first, with the other person's name and @tag for transfers. */
  /** How many orders this person has paid from the wallet so far (the first few carry no fee). */
  async orderPaymentCount(userId: string): Promise<number> {
    return (await jsonRow<{ n: number }>(this.db, sql`select count(*)::int as n from public.wallet_entries where user_id = ${userId} and kind = 'order_payment'`))?.n ?? 0;
  }

  entries(userId: string, limit: number, before: string | null) {
    return jsonRows<Record<string, unknown>>(
      this.db,
      sql`select e.id, e.kind, e.amount_kobo::text as amount_kobo, e.balance_after_kobo::text as balance_after_kobo, e.order_id, e.reference, e.note, e.created_at,
                 e.counterparty_id, cu.name as counterparty_name, cu.avatar_url as counterparty_avatar, cw.handle as counterparty_handle,
                 wd.status as withdrawal_status, wd.bank_name, wd.account_last4, wd.account_name
          from public.wallet_entries e
          left join public.users cu on cu.id = e.counterparty_id
          left join public.wallet_accounts cw on cw.user_id = e.counterparty_id
          left join public.wallet_withdrawals wd on wd.id = e.withdrawal_id
          where e.user_id = ${userId} and (${before}::timestamptz is null or e.created_at < ${before}::timestamptz)
          order by e.created_at desc, e.id desc limit ${limit}`,
    );
  }

  async insertTransfer(fromUser: string, toUser: string, amountKobo: number, note: string | null, key: string | null): Promise<string | null> {
    const rows = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.wallet_transfers (from_user, to_user, amount_kobo, note, idempotency_key) values (${fromUser}, ${toUser}, ${amountKobo}, ${note}, ${key})
          on conflict do nothing returning id`,
    );
    return rows[0]?.id ?? null;
  }

  transferByKey(fromUser: string, key: string) {
    return jsonRow<{ id: string; to_user: string; amount_kobo: string }>(this.db, sql`select id, to_user, amount_kobo::text as amount_kobo from public.wallet_transfers where from_user = ${fromUser} and idempotency_key = ${key}`);
  }

  /** Where this person's withdrawals go: the shop's payout account if they have a shop, otherwise their own bank account. */
  withdrawalAccount(userId: string): Promise<WithdrawalAccount | null> {
    return jsonRow<WithdrawalAccount>(
      this.db,
      sql`select * from (
            select 'shop'::text as source, v.transfer_recipient_code as recipient_code, v.bank_name, v.account_name, right(v.account_number, 4) as last4,
                   v.payout_verified_at as verified_at, (extract(epoch from (now() - v.payout_verified_at)) / 3600)::float as age_hours, 1 as pref
              from public.vendors v where v.user_id = ${userId} and v.deleted_at is null and v.transfer_recipient_code is not null and v.payout_verified_at is not null
            union all
            select 'buyer'::text, b.transfer_recipient_code, b.bank_name, b.account_name, b.account_last4, b.verified_at,
                   (extract(epoch from (now() - b.verified_at)) / 3600)::float, 2
              from public.buyer_payout_accounts b where b.user_id = ${userId}
          ) a order by pref limit 1`,
    );
  }

  /** Whether money already went to this account since it was saved (the first withdrawal to a new or changed account is checked by an admin). */
  async paidToAccountSince(userId: string, recipientCode: string, since: string): Promise<boolean> {
    return (
      (await jsonRow(
        this.db,
        sql`select 1 as x from public.wallet_withdrawals where user_id = ${userId} and recipient_code = ${recipientCode} and created_at >= ${since}::timestamptz
              and status in ('processing', 'success') limit 1`,
      )) !== null
    );
  }

  async insertWithdrawal(w: { userId: string; amountKobo: number; feeKobo: number; status: "requested" | "processing"; reviewReason: string | null; reference: string; account: WithdrawalAccount }): Promise<string> {
    const [row] = await jsonReturning<{ id: string }>(
      this.db,
      sql`insert into public.wallet_withdrawals (user_id, amount_kobo, fee_kobo, status, review_reason, transfer_reference, recipient_code, bank_name, account_name, account_last4)
          values (${w.userId}, ${w.amountKobo}, ${w.feeKobo}, ${w.status}, ${w.reviewReason}, ${w.reference}, ${w.account.recipient_code}, ${w.account.bank_name}, ${w.account.account_name}, ${w.account.last4}) returning id`,
    );
    return row!.id;
  }

  withdrawal(id: string): Promise<WalletWithdrawal | null> {
    return jsonRow<WalletWithdrawal>(this.db, sql`select id, user_id, amount_kobo::text as amount_kobo, fee_kobo::text as fee_kobo, status, review_reason, transfer_reference, recipient_code, bank_name, account_name, account_last4, reject_reason, created_at from public.wallet_withdrawals where id = ${id} for update`);
  }

  withdrawalByReference(reference: string): Promise<WalletWithdrawal | null> {
    return jsonRow<WalletWithdrawal>(this.db, sql`select id, user_id, amount_kobo::text as amount_kobo, fee_kobo::text as fee_kobo, status, review_reason, transfer_reference, recipient_code, bank_name, account_name, account_last4, reject_reason, created_at from public.wallet_withdrawals where transfer_reference = ${reference} for update`);
  }

  async setWithdrawal(id: string, status: string, f: { error?: string | null; code?: string | null; decidedBy?: string | null; rejectReason?: string | null } = {}): Promise<void> {
    await this.db.execute(sql`
      update public.wallet_withdrawals set status = ${status}, last_error = coalesce(${f.error ?? null}, last_error), transfer_code = coalesce(${f.code ?? null}, transfer_code),
             decided_by = coalesce(${f.decidedBy ?? null}::uuid, decided_by), decided_at = case when ${f.decidedBy ?? null}::uuid is null then decided_at else now() end,
             reject_reason = coalesce(${f.rejectReason ?? null}, reject_reason)
      where id = ${id}`);
  }

  recentWithdrawals(userId: string, limit = 10) {
    return jsonRows<Record<string, unknown>>(this.db, sql`select id, amount_kobo::text as amount_kobo, status, review_reason, bank_name, account_last4, reject_reason, created_at from public.wallet_withdrawals where user_id = ${userId} order by created_at desc limit ${limit}`);
  }

  /** Admin: withdrawals (waiting ones first) with who asked and why it waits. */
  adminWithdrawals(status: string | null, limit: number) {
    return jsonRows<Record<string, unknown>>(
      this.db,
      sql`select w.id, w.user_id, u.name, a.handle, w.amount_kobo::text as amount_kobo, w.status, w.review_reason, w.bank_name, w.account_name, w.account_last4,
                 w.reject_reason, w.created_at, w.decided_at, a.balance_kobo::text as balance_kobo
          from public.wallet_withdrawals w join public.users u on u.id = w.user_id left join public.wallet_accounts a on a.user_id = w.user_id
          where (${status}::text is null or w.status = ${status}) order by (w.status = 'requested') desc, w.created_at desc limit ${limit}`,
    );
  }

  /** Admin: wallets by @tag or name, with their balance. */
  adminWallets(q: string | null, limit: number) {
    const like = q ? "%" + q.toLowerCase().replace(/^@/, "").replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null;
    return jsonRows<Record<string, unknown>>(
      this.db,
      sql`select a.user_id, a.handle, u.name, u.role::text as role, a.balance_kobo::text as balance_kobo, a.frozen, a.frozen_reason, a.updated_at
          from public.wallet_accounts a join public.users u on u.id = a.user_id
          where (${like}::text is null or a.handle like ${like} or lower(u.name) like ${like})
            and (${like}::text is not null or a.balance_kobo > 0 or a.frozen)   -- only wallets that hold money (or are on hold), unless searching
          order by a.balance_kobo desc, a.updated_at desc limit ${limit}`,
    );
  }

  async setFrozen(userId: string, frozen: boolean, reason: string | null): Promise<void> {
    await this.db.execute(sql`update public.wallet_accounts set frozen = ${frozen}, frozen_reason = ${frozen ? reason : null} where user_id = ${userId}`);
  }

  /** Money held in every wallet together (what Levromart's Paystack balance must always cover). */
  async totalHeldKobo(): Promise<number> {
    const r = await jsonRow<{ k: string }>(this.db, sql`select coalesce(sum(balance_kobo), 0)::text as k from public.wallet_accounts`);
    return Number(r?.k ?? 0);
  }

  async logAdminAction(adminId: string, action: string, targetId: string, label: string): Promise<void> {
    await this.db.execute(sql`
      insert into public.admin_actions (admin_id, admin_name, action, target_type, target_id, target_label)
      select ${adminId}, u.name, ${action}, 'user', ${targetId}, ${label} from public.users u where u.id = ${adminId}`);
  }
}
