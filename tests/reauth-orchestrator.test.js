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

test('runForAccount disables account with sms-failed note on phone-2FA failure', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => true,
    executeStep: async (step) => { if (step === 7) throw new Error('add-phone required'); },
  });
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: 42 });
  assert.equal(result.status, 'sms-failed');
  assert.deepEqual(deps._calls.disabled, [{ id: 42, note: 'sms-failed' }]);
});

test('phone-2FA failure without accountId looks up id by email before disabling', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => true,
    executeStep: async () => { throw new Error('add-phone'); },
  });
  deps.cpaAdminClient.listAccounts = async () => [{ id: 99, email: 'a@x.com' }];
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: null });
  assert.equal(result.status, 'sms-failed');
  assert.deepEqual(deps._calls.disabled, [{ id: 99, note: 'sms-failed' }]);
});

test('phone-2FA failure with no resolvable id logs and skips disable', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => true,
    executeStep: async () => { throw new Error('add-phone'); },
  });
  deps.cpaAdminClient.listAccounts = async () => [];
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: null });
  assert.equal(result.status, 'sms-failed');
  assert.equal(deps._calls.disabled.length, 0);
});

test('non-phone failure returns failed without disabling or recording', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => false,
    executeStep: async () => { throw new Error('network blip'); },
  });
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(deps._calls.disabled.length, 0);
  assert.equal(deps._calls.appended.length, 0);
});
