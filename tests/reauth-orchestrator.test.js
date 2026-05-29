const test = require('node:test');
const assert = require('node:assert/strict');

const { createReauthOrchestrator } = require('../background/reauth-orchestrator.js');

function makeDeps(overrides = {}) {
  const state = { current: {} };
  const calls = { steps: [], logs: [], disabled: [], appended: [] };
  return {
    getState: async () => ({ ...state.current }),
    setState: async (patch) => { Object.assign(state.current, patch); },
    addLog: async (msg, level) => { calls.logs.push({ msg, level }); },
    executeStep: async (step) => { calls.steps.push(step); },
    isAddPhoneAuthFailure: () => false,
    getFixedPassword: () => 'fixedpw',
    appendAccountRunRecord: async (status, st, reason) => { calls.appended.push({ status, reason }); },
    cpaAdminClient: {
      listAccounts: async () => [],
      disableAccount: async (id, note) => { calls.disabled.push({ id, note }); },
    },
    _state: state,
    _calls: calls,
    ...overrides,
  };
}

test('runForAccount injects email/password/cpa context and clears signupPhone', async () => {
  const deps = makeDeps();
  const orch = createReauthOrchestrator(deps);
  await orch.runForAccount({ email: 'a@x.com', accountId: 1 });
  assert.equal(deps._state.current.email, 'a@x.com');
  assert.equal(deps._state.current.password, 'fixedpw');
  assert.equal(deps._state.current.panelMode, 'cpa');
  assert.equal(deps._state.current.signupPhone, null);
  assert.equal(deps._state.current.signupPhoneCountry, null);
});

test('runForAccount runs steps 7,8,9,10 in order and returns success', async () => {
  const deps = makeDeps();
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: 1 });
  assert.deepEqual(deps._calls.steps, [7, 8, 9, 10]);
  assert.equal(result.status, 'success');
  assert.equal(result.email, 'a@x.com');
  assert.equal(deps._calls.appended.length, 1);
});
