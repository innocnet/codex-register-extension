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
