const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageRouter } = require('../background/message-router.js');

function makeRouter(overrides = {}) {
  const calls = { fetchAbnormal: 0, runArgs: null };
  const deps = {
    getState: async () => ({ stepStatuses: {}, accountRunHistory: [] }),
    reauthFetchAbnormal: async () => { calls.fetchAbnormal += 1; return [{ id: 1, email: 'a@x.com' }]; },
    reauthRunAccount: async (payload) => { calls.runArgs = payload; return { status: 'success', email: payload.email }; },
  };
  return { router: createMessageRouter({ ...deps, ...overrides }), calls };
}

test('REAUTH_FETCH_ABNORMAL returns accounts list', async () => {
  const { router, calls } = makeRouter();
  const res = await router.handleMessage({ type: 'REAUTH_FETCH_ABNORMAL', source: 'sidepanel' });
  assert.equal(calls.fetchAbnormal, 1);
  assert.equal(res.ok, true);
  assert.equal(res.accounts.length, 1);
});

test('REAUTH_RUN_ACCOUNT forwards email and accountId', async () => {
  const { router, calls } = makeRouter();
  const res = await router.handleMessage({
    type: 'REAUTH_RUN_ACCOUNT',
    source: 'sidepanel',
    payload: { email: 'a@x.com', accountId: 7 },
  });
  assert.deepEqual(calls.runArgs, { email: 'a@x.com', accountId: 7 });
  assert.equal(res.ok, true);
  assert.equal(res.result.status, 'success');
});
