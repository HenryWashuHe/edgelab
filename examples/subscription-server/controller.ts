// Local fixture controller only. No full upstream entry point or RPC transport.
import { DurableObject } from 'cloudflare:workers';
import { ExtractedImpl, ExtractedClient } from './extracted.ts';

const subscriberIds = ['primary', 'replay'];

class ControlledSubscriber {
  disposed = false;
  broken = undefined;
  constructor(owner, id, rejectRevision) {
    this.owner = owner;
    this.id = id;
    this.rejectRevision = rejectRevision;
  }
  dup() {
    return this;
  }
  onRpcBroken(callback) {
    this.broken = callback;
  }
  streamGeneration(value) {
    this.owner.notifications.push({ subscriberId: this.id, kind: 'stream', value });
    return this.disposed
      ? Promise.reject(new Error('Controlled disposed facade'))
      : Promise.resolve();
  }
  metadata(record) {
    this.owner.notifications.push({
      subscriberId: this.id,
      kind: 'metadata',
      value: record.codeBase?.revision ?? 0,
    });
    return this.disposed
      ? Promise.reject(new Error('Controlled disposed facade'))
      : Promise.resolve();
  }
  message(record) {
    this.owner.notifications.push({
      subscriberId: this.id,
      kind: 'message',
      value: record.sequence,
    });
    return this.disposed
      ? Promise.reject(new Error('Controlled disposed facade'))
      : Promise.resolve();
  }
  deleted(id) {
    this.owner.notifications.push({ subscriberId: this.id, kind: 'deleted', value: id });
    return Promise.resolve();
  }
  changeApplied(chatId, generation, revision, author, change, submission) {
    const result = this.disposed || revision === this.rejectRevision ? 'rejected' : 'fulfilled';
    const record = { subscriberId: this.id, generation, revision, result };
    this.owner.attempts.push(record);
    this.owner.deliveries.push(
      result === 'fulfilled'
        ? {
            ...record,
            row: structuredClone({
              generation,
              revision,
              author,
              change,
              ...(submission ? { submission } : {}),
            }),
          }
        : record,
    );
    // Rejection happens before the Node bridge forwards any row into the actual OT client.
    return result === 'fulfilled'
      ? Promise.resolve()
      : Promise.reject(new Error('Controlled callback rejection'));
  }
  [Symbol.dispose]() {
    if (!this.disposed) {
      this.disposed = true;
      this.owner.disposals++;
    }
  }
}

export class SubscriptionFixture extends DurableObject {
  impl;
  client;
  facades = new Map();
  subscriptions = new Map();
  attempts = [];
  deliveries = [];
  notifications = [];
  disposals = 0;
  instanceOrdinal;

  constructor(ctx, env) {
    super(ctx, env);
    if (typeof Symbol.dispose !== 'symbol' || typeof ctx.storage.kv.get !== 'function') {
      throw new Error('Native synchronous Durable Object KV is required');
    }
    this.instanceOrdinal = (ctx.storage.kv.get('fixture-instance-ordinal') ?? 0) + 1;
    ctx.storage.kv.put('fixture-instance-ordinal', this.instanceOrdinal);
    this.impl = new ExtractedImpl(ctx);
    this.client = new ExtractedClient(this.impl);
    if (!this.impl.storage.chatMeta.get(1)) {
      // Explicit synthetic initial state; this does not exercise an upstream epoch transition.
      this.impl.storage.chatMeta.put({
        id: 1,
        lastActive: new Date(0),
        hasProposedChanges: false,
        codeBase: {
          generation: 1,
          revision: 0,
          pins: [{ gadgetId: 1, baseCommit: 'fixture-base' }],
        },
      });
    }
  }

  sample() {
    const codeBase = this.impl.storage.chatMeta.get(1).codeBase;
    return {
      generation: codeBase.generation,
      revision: codeBase.revision,
      codeBase: structuredClone(codeBase),
      streamGeneration: this.impl.streamGeneration,
      instanceOrdinal: this.instanceOrdinal,
      retained: [...this.impl.storage.chatChanges.list()].map((row) => ({
        generation: row.generation,
        revision: row.revision,
        retired: !!row.retired,
      })),
      subscriberCount: this.impl.subscriberCount(),
      attempts: this.attempts.map((item) => ({ ...item })),
      notifications: this.notifications.map((item) => ({ ...item })),
      disposals: this.disposals,
      sqlProbe: this.ctx.storage.sql.exec('SELECT 1 AS live').one().live,
      observedAt: Date.now(),
    };
  }

  async fetch(request) {
    const route = new URL(request.url).pathname.slice(1);
    const body = request.method === 'POST' ? await request.json() : {};
    if (
      ![
        'sample',
        'sync',
        'append',
        'subscribe',
        'deliveries',
        'unsubscribe',
        'break',
        'retire',
        'message',
      ].includes(route)
    ) {
      return Response.json({ status: 'unknown-route' }, { status: 404 });
    }
    if (
      Object.keys(body).some(
        (key) => !['subscriberId', 'rejectRevision', 'startAfter', 'throughRevision'].includes(key),
      )
    ) {
      return Response.json({ status: 'invalid-command' }, { status: 400 });
    }
    let response;
    if (route === 'append') {
      if (this.impl.storage.chatMeta.get(1).codeBase.revision >= 8)
        return Response.json({ status: 'bounded' }, { status: 409 });
      const accepted = this.impl.appendControlled();
      response = {
        status: 'accepted',
        generation: accepted.generation,
        revision: accepted.revision,
      };
    } else if (route === 'subscribe') {
      const { subscriberId, rejectRevision = 0, startAfter } = body;
      if (
        !subscriberIds.includes(subscriberId) ||
        !Number.isInteger(rejectRevision) ||
        rejectRevision < 0 ||
        rejectRevision > 8 ||
        (startAfter !== undefined && (!Number.isSafeInteger(startAfter) || startAfter < 0))
      ) {
        return Response.json({ status: 'invalid-command' }, { status: 400 });
      }
      if (this.subscriptions.has(subscriberId))
        return Response.json({ status: 'duplicate-subscription' }, { status: 409 });
      const facade = new ControlledSubscriber(this, subscriberId, rejectRevision);
      this.facades.set(subscriberId, facade);
      this.subscriptions.set(
        subscriberId,
        await this.client.subscribeToChat(
          facade,
          startAfter === undefined ? undefined : new Date(startAfter),
        ),
      );
      response = { status: 'subscribed' };
    } else if (route === 'deliveries') {
      response = this.deliveries.splice(0);
    } else if (route === 'unsubscribe' || route === 'break') {
      if (!subscriberIds.includes(body.subscriberId))
        return Response.json({ status: 'invalid-command' }, { status: 400 });
      if (route === 'unsubscribe') this.subscriptions.get(body.subscriberId)?.[Symbol.dispose]();
      else this.facades.get(body.subscriberId)?.broken?.(new Error('Controlled transport break'));
      this.subscriptions.delete(body.subscriberId);
      response = { status: 'unsubscribed' };
    } else if (route === 'retire') {
      if (
        !Number.isInteger(body.throughRevision) ||
        body.throughRevision < 1 ||
        body.throughRevision > 8
      )
        return Response.json({ status: 'invalid-command' }, { status: 400 });
      this.impl.retireControlled(body.throughRevision);
      response = { status: 'retired' };
    } else if (route === 'message') {
      // Fixed synthetic history only; no action hydration or materialization is fabricated.
      if (this.impl.storage.chats.get('a1.a1'))
        return Response.json({ status: 'already-seeded' }, { status: 409 });
      this.impl.storage.chats.put({
        chatId: 1,
        sequence: 1,
        timestamp: this.impl.getChatTimestamp(),
        type: 'message',
        message: 'Controlled fixture',
        author: { type: 'agent', id: 'controlled-fixture', name: 'Controlled fixture' },
      });
      response = { status: 'message-seeded' };
    } else {
      response = this.sample();
    }
    // A native storage boundary, followed by a microtask checkpoint, is observed before returning.
    // This does not change the extracted producer/subscribe algorithm or replace its catch paths.
    await this.ctx.storage.sync();
    await Promise.resolve();
    return Response.json(response);
  }
}

export default {
  fetch(request, env) {
    return env.FIXTURE.get(env.FIXTURE.idFromName('controlled-instance')).fetch(request);
  },
};
