const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'background/message-router.js'), 'utf8');
const api = new Function('self', `${source}; return self.MultiPageBackgroundMessageRouter;`)({});

function createRouter(overrides = {}) {
  const calls = [];
  const state = overrides.state || { stepStatuses: {}, email: 'user@example.com', password: 'pw' };
  const setStateCalls = [];
  const silentEmailStates = [];
  const router = api.createMessageRouter({
    addLog: async () => {},
    appendAccountRunRecord: async () => null,
    batchUpdateLuckmailPurchases: async () => {},
    buildLocalhostCleanupPrefix: () => '',
    buildLuckmailSessionSettingsPayload: () => ({}),
    buildPersistentSettingsPayload: () => ({}),
    broadcastDataUpdate: () => {},
    cancelScheduledAutoRun: async () => {},
    checkHerosmsBalance: async () => ({ ok: true, balance: '12.34' }),
    checkIcloudSession: async () => {},
    clearAccountRunHistory: async () => {},
    clearAutoRunTimerAlarm: async () => {},
    clearLuckmailRuntimeState: async () => {},
    clearStopRequest: () => calls.push(['clearStopRequest']),
    closeLocalhostCallbackTabs: async () => {},
    closeTabsByUrlPrefix: async () => {},
    deleteAccountRunHistoryRecords: async () => {},
    deleteHotmailAccount: async () => {},
    deleteHotmailAccounts: async () => {},
    deleteIcloudAlias: async () => {},
    deleteUsedIcloudAliases: async () => {},
    disableUsedLuckmailPurchases: async () => {},
    doesStepUseCompletionSignal: () => false,
    ensureManualInteractionAllowed: async () => state,
    executeStep: async () => {},
    executeStepViaCompletionSignal: async () => {},
    exportSettingsBundle: async () => ({}),
    fetchGeneratedEmail: async () => '',
    finalizeStep3Completion: async () => {},
    finalizeIcloudAliasAfterSuccessfulFlow: async () => calls.push(['finalizeIcloud']),
    finalizeSuccessfulRegistrationArtifacts: overrides.finalizeSuccessfulRegistrationArtifacts || (async (passedState) => calls.push(['finalizeSuccess', passedState])),
    findHotmailAccount: () => null,
    flushCommand: () => {},
    getCurrentLuckmailPurchase: () => null,
    getPendingAutoRunTimerPlan: () => null,
    getSourceLabel: () => '',
    getState: async () => state,
    getStopRequested: () => false,
    handleAutoRunLoopUnhandledError: async () => {},
    handleCloudflareSecurityBlocked: async () => '',
    importSettingsBundle: async () => {},
    invalidateDownstreamAfterStepRestart: async () => {},
    isCloudflareSecurityBlockedError: () => false,
    isAutoRunLockedState: () => false,
    isHotmailProvider: () => false,
    isLocalhostOAuthCallbackUrl: () => true,
    isLuckmailProvider: () => false,
    isStopError: () => false,
    launchAutoRunTimerPlan: async () => {},
    listIcloudAliases: async () => [],
    listLuckmailPurchasesForManagement: async () => [],
    normalizeHotmailAccounts: (items) => items,
    normalizeRunCount: (value) => value,
    AUTO_RUN_TIMER_KIND_SCHEDULED_START: 'scheduled',
    notifyStepComplete: () => {},
    notifyStepError: () => {},
    patchHotmailAccount: async () => {},
    phoneVerifyCancel: async (reason) => {
      calls.push(['phoneCancel', reason]);
      return { ok: true, cancelled: true, reason };
    },
    phoneVerifyComplete: async () => ({ ok: true, completed: true }),
    phoneVerifyPollForCode: async () => ({ ok: true, code: '123456' }),
    phoneVerifyReplaceNumber: async (payload) => ({ ok: true, activation: { id: 'new', reason: payload.reason } }),
    phoneVerifyRequestNumber: async () => ({ ok: true, activation: { id: 'act', phone: '56911111111' } }),
    phoneVerifyResendCurrentNumber: async () => ({ ok: true, resent: true, resendCount: 1 }),
    phoneVerifyStatus: async () => ({ ok: true, activation: { id: 'act' } }),
    registerTab: async () => {},
    requestStop: async () => calls.push(['requestStop']),
    resetState: async () => {},
    resumeAutoRun: async () => {},
    reexportAccountsFile: async () => ({ ok: true, saved: 2 }),
    scheduleAutoRun: async () => ({}),
    selectLuckmailPurchase: async () => {},
    setCurrentHotmailAccount: async () => {},
    setEmailState: async () => {},
    setEmailStateSilently: async (email) => { silentEmailStates.push(email); },
    setIcloudAliasPreservedState: async () => {},
    setIcloudAliasUsedState: async () => {},
    setLuckmailPurchaseDisabledState: async () => {},
    setLuckmailPurchasePreservedState: async () => {},
    setLuckmailPurchaseUsedState: async () => {},
    setPersistentSettings: async () => {},
    setState: async (updates) => { setStateCalls.push(updates); },
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: overrides.shouldUseCustomRegistrationEmail || (() => false),
    skipAutoRunCountdown: async () => false,
    skipStep: async () => {},
    startAutoRunLoop: () => {},
    syncHotmailAccounts: async () => {},
    testHotmailAccountMailAccess: async () => ({}),
    upsertHotmailAccount: async () => ({}),
    verifyHotmailAccount: async () => ({}),
  });
  return { router, calls, state, setStateCalls, silentEmailStates };
}

test('routes phone verification messages to injected handlers', async () => {
  const { router } = createRouter();

  assert.deepEqual(await router.handleMessage({ type: 'PHONE_VERIFY_START', payload: {} }, {}), {
    ok: true,
    activation: { id: 'act', phone: '56911111111' },
  });
  assert.deepEqual(await router.handleMessage({ type: 'PHONE_VERIFY_POLL' }, {}), { ok: true, code: '123456' });
  assert.deepEqual(await router.handleMessage({ type: 'PHONE_VERIFY_RESEND' }, {}), { ok: true, resent: true, resendCount: 1 });
  assert.deepEqual(await router.handleMessage({ type: 'PHONE_VERIFY_NEW_NUMBER', payload: { reason: 'rejected' } }, {}), {
    ok: true,
    activation: { id: 'new', reason: 'rejected' },
  });
  assert.deepEqual(await router.handleMessage({ type: 'PHONE_VERIFY_CANCEL', payload: { reason: 'stop' } }, {}), {
    ok: true,
    cancelled: true,
    reason: 'stop',
  });
});

test('reset cancels phone verification before clearing state', async () => {
  const { router, calls } = createRouter();

  await router.handleMessage({ type: 'RESET' }, {});

  assert.deepEqual(calls, [
    ['clearStopRequest'],
    ['phoneCancel', 'RESET_FLOW'],
  ]);
});

test('step 9 completion clears oauth flow deadline state', async () => {
  const { router, setStateCalls } = createRouter();

  await router.handleMessage({
    type: 'STEP_COMPLETE',
    step: 9,
    payload: { localhostUrl: 'http://localhost:1455/auth/callback?code=1' },
    source: 'signup-page',
  }, {});

  assert.deepEqual(setStateCalls.at(-1), {
    localhostUrl: 'http://localhost:1455/auth/callback?code=1',
    oauthFlowDeadlineAt: null,
    oauthFlowDeadlineSourceUrl: null,
  });
});

test('step 10 completion finalizes successful registration artifacts', async () => {
  const { router, calls, state } = createRouter();

  await router.handleMessage({ type: 'STEP_COMPLETE', step: 10, payload: {}, source: 'signup-page' }, {});

  assert.deepEqual(calls, [
    ['finalizeIcloud'],
    ['finalizeSuccess', state],
  ]);
});

test('step 10 completion clears custom registration email when required', async () => {
  const { router, silentEmailStates } = createRouter({
    shouldUseCustomRegistrationEmail: () => true,
  });

  await router.handleMessage({ type: 'STEP_COMPLETE', step: 10, payload: {}, source: 'signup-page' }, {});

  assert.deepEqual(silentEmailStates, [null]);
});

test('routes HeroSMS balance check message', async () => {
  const { router } = createRouter();

  assert.deepEqual(await router.handleMessage({ type: 'HEROSMS_CHECK_BALANCE' }, {}), { ok: true, balance: '12.34' });
});

test('routes accounts reexport message', async () => {
  const { router } = createRouter();

  assert.deepEqual(await router.handleMessage({ type: 'ACCOUNTS_REEXPORT' }, {}), { ok: true, saved: 2 });
});
