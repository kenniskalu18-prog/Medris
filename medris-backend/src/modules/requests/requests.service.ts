import type { DataContext, Identity } from "../../database/context.js";
import { EquipmentRequestsRepository, type NewEquipmentRequest } from "../../database/repositories/equipment-requests.repository.js";

/** Buyers' requests and shops' offers. Runs as the user, so row-level security and the triggers still decide. */
export class RequestsService {
  constructor(private readonly db: () => DataContext) {}

  mine(me: Identity): Promise<Record<string, unknown>[]> {
    return this.db().asUser(me, (tx) => new EquipmentRequestsRepository(tx).mine(me.userId));
  }

  open(me: Identity | null): Promise<Record<string, unknown>[]> {
    const read = (tx: Parameters<Parameters<DataContext["asAnon"]>[0]>[0]) => new EquipmentRequestsRepository(tx).open();
    return me ? this.db().asUser(me, read) : this.db().asAnon(read);
  }

  async create(me: Identity, r: NewEquipmentRequest): Promise<{ id: string }> {
    return { id: await this.db().asUser(me, (tx) => new EquipmentRequestsRepository(tx).create(me.userId, r)) };
  }

  async cancel(me: Identity, requestId: string): Promise<{ cancelled: number }> {
    return { cancelled: await this.db().asUser(me, (tx) => new EquipmentRequestsRepository(tx).cancel(me.userId, requestId)) };
  }

  async offer(me: Identity, requestId: string, vendorId: string, message: string | null, price: number | null): Promise<{ id: string }> {
    return { id: await this.db().asUser(me, (tx) => new EquipmentRequestsRepository(tx).offer(requestId, vendorId, message, price)) };
  }
}
