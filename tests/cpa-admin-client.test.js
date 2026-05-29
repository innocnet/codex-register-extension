const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCpaAdminClient,
  CpaAdminError,
  DEFAULTS,
} = require('../background/cpa-admin-client.js');

function makeFetchStub(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses[i] || responses[responses.length - 1];
    i += 1;
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };
  return { fetchImpl, calls };
}

test('factory derives origin from a CPA management url and builds auth header', () => {
  const { fetchImpl } = makeFetchStub([]);
  const client = createCpaAdminClient({
    fetchImpl,
    baseUrl: 'https://host.example/management.html#/oauth',
    managementKey: 'KEY123',
  });
  assert.equal(client.origin, 'https://host.example');
  assert.deepEqual(client.authHeader(), { Authorization: 'Bearer KEY123' });
});

test('factory throws when managementKey missing', () => {
  const { fetchImpl } = makeFetchStub([]);
  assert.throws(
    () => createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: '' }),
    /managementKey/
  );
});

test('listAccounts GETs list path with auth header and returns data array', async () => {
  const { fetchImpl, calls } = makeFetchStub([
    { status: 200, body: { data: [{ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@y.com' }] } },
  ]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const accounts = await client.listAccounts();
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[0], { id: 1, email: 'a@x.com' });
  assert.equal(calls[0].url, 'https://h.x/api/v1/admin/accounts');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer K');
});

test('listAccounts throws CpaAdminError on non-2xx', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 500, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  await assert.rejects(() => client.listAccounts(), /HTTP 500/);
});

test('probeAccount returns abnormal=true on 401', async () => {
  const { fetchImpl, calls } = makeFetchStub([{ status: 401, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const result = await client.probeAccount(7);
  assert.deepEqual(result, { abnormal: true });
  assert.equal(calls[0].url, 'https://h.x/api/v1/admin/accounts/7/refresh');
  assert.equal(calls[0].opts.method, 'POST');
});

test('probeAccount returns abnormal=false on 2xx', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 200, body: { ok: true } }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  assert.deepEqual(await client.probeAccount(7), { abnormal: false });
});

test('probeAccount returns {error} on unexpected status', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 503, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const result = await client.probeAccount(7);
  assert.equal(result.abnormal, false);
  assert.match(result.error, /503/);
});
