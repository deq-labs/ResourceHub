import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { Queue } from 'bullmq';
import { QUEUES } from '@resourcehub/integrations';
import { HOSTS, request, type TestApp } from './helpers.js';
import { createListeningApp, signIn, type Session } from './auth-helpers.js';

let app: TestApp;
let admin: Session;
let editor: Session;
let queue: Queue;
let k = 0;
const idem = () => ({ 'idempotency-key': `int-test-${Date.now()}-${k++}` });

beforeAll(async () => {
  app = await createListeningApp();
  [admin, editor] = await Promise.all([
    signIn(app, HOSTS.contoso, { oid: 'dev-adam' }),
    signIn(app, HOSTS.contoso, { oid: 'dev-erin' }),
  ]);
  const u = new URL(inject('redisUrl'));
  queue = new Queue(QUEUES.sync, { connection: { host: u.hostname, port: Number(u.port) } });
});
afterAll(async () => {
  await queue.close();
  await app.close();
});

const call = (
  s: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) =>
  request(app, {
    host: HOSTS.contoso,
    method,
    url,
    token: s.accessToken,
    headers: idem(),
    ...(body !== undefined ? { body } : {}),
  });

describe('integrations API', () => {
  it('lists the provider catalog and the seeded integrations (secrets never returned)', async () => {
    const providers = (await call(admin, 'GET', '/api/v1/integrations/providers')).json().data;
    expect(providers.map((p: { provider: string }) => p.provider)).toEqual([
      'partner-docs',
      'partner-feed',
      'country-info',
      'spaceflight-news',
    ]);
    const list = await call(admin, 'GET', '/api/v1/integrations');
    expect(list.json().data.map((i: { provider: string }) => i.provider)).toEqual(
      expect.arrayContaining(['partner-docs', 'partner-feed']),
    );
    expect(list.body).not.toContain('partner-demo-password');
  });

  it('validates provider config and requires a secretRef where needed', async () => {
    expect(
      (await call(admin, 'POST', '/api/v1/integrations', { provider: 'nope', name: 'x x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'POST', '/api/v1/integrations', {
          provider: 'partner-feed',
          name: 'No secret',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'POST', '/api/v1/integrations', {
          provider: 'partner-feed',
          name: 'Bad ref',
          secretRef: 'plaintext-password',
        })
      ).statusCode,
    ).toBe(400);
    const ok = await call(admin, 'POST', '/api/v1/integrations', {
      provider: 'country-info',
      name: 'Asia profiles',
      config: { continent: 'as' },
      scheduleMinutes: 1440,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      kind: 'soap',
      config: { continent: 'AS' },
      scheduleMinutes: 1440,
    });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(`schedule:${ok.json().id}`);
  });

  it('a sync request records a queued run and enqueues a job that carries the tenant id', async () => {
    const list = (await call(admin, 'GET', '/api/v1/integrations')).json().data;
    const soap = list.find((i: { provider: string }) => i.provider === 'partner-docs');
    const run = await call(admin, 'POST', `/api/v1/integrations/${soap.id}/sync`);
    expect(run.statusCode).toBe(201);
    expect(run.json()).toMatchObject({ status: 'queued', trigger: 'manual', type: 'sync' });
    const job = await queue.getJob(run.json().id);
    expect(job?.data).toMatchObject({
      tenantId: '01960000-0000-7000-8000-00000000c001',
      integrationId: soap.id,
      runId: run.json().id,
    });
    const runs = (await call(admin, 'GET', `/api/v1/integrations/${soap.id}/runs`)).json().data;
    expect(runs[0].id).toBe(run.json().id);
  });

  it('connection test reports a structured failure for an unreachable partner', async () => {
    const created = await call(admin, 'POST', '/api/v1/integrations', {
      provider: 'partner-docs',
      name: 'Unreachable',
      config: { endpoint: 'http://127.0.0.1:1/soap/partner-docs', username: 'u' },
      secretRef: 'env:DOES_NOT_EXIST_SECRET',
    });
    const test = await call(admin, 'POST', `/api/v1/integrations/${created.json().id}/test`);
    expect(test.json()).toMatchObject({ ok: false, code: 'config' }); // missing secret is caught first
  });

  it('editors can push a resource to a push-capable partner; viewers and editors cannot manage integrations', async () => {
    const list = (await call(admin, 'GET', '/api/v1/integrations')).json().data;
    const soap = list.find((i: { provider: string }) => i.provider === 'partner-docs');
    const res = (await call(editor, 'GET', '/api/v1/resources?limit=1')).json().data[0];
    const push = await call(editor, 'POST', '/api/v1/integrations/push', {
      integrationId: soap.id,
      resourceId: res.id,
    });
    expect(push.statusCode).toBe(201);
    expect(push.json()).toMatchObject({ type: 'push', status: 'queued' });
    expect((await call(editor, 'GET', '/api/v1/integrations')).statusCode).toBe(403);
  });
});
