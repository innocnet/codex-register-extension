const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPhoneVerifyFlow,
  DEFAULT_COUNTRY_SEQUENCE,
  COUNTRY_CODES,
  SERVICE_OPENAI,
  STATUS_CODES,
  NewNumberRequiredError,
  PollTimeoutError,
} = require('../background/phone-verify-flow.js');

function makeClient(overrides = {}) {
  const calls = [];
  const client = {
    getNumber: async (args) => {
      calls.push({ method: 'getNumber', args });
      if (overrides.getNumber) return overrides.getNumber(args);
      return { id: 'act-1', phone: '56911111111' };
    },
    getStatus: async (id) => {
      calls.push({ method: 'getStatus', id });
      if (overrides.getStatus) return overrides.getStatus(id);
      return { status: 'wait' };
    },
    setStatus: async (id, status) => {
      calls.push({ method: 'setStatus', id, status });
      if (overrides.setStatus) return overrides.setStatus(id, status);
    },
  };
  return { client, calls };
}

class NoNumbersError extends Error {
  constructor() {
    super('NO_NUMBERS');
    this.name = 'NoNumbersError';
    this.code = 'NO_NUMBERS';
  }
}

test('requestNumber succeeds with default first country Chile and service oi', async () => {
  const { client, calls } = makeClient();
  const flow = createPhoneVerifyFlow({ herosmsClient: client });

  const activation = await flow.requestNumber();

  assert.equal(DEFAULT_COUNTRY_SEQUENCE[0], COUNTRY_CODES.CHILE);
  assert.equal(activation.id, 'act-1');
  assert.equal(activation.phone, '56911111111');
  assert.equal(activation.country, COUNTRY_CODES.CHILE);
  assert.equal(activation.service, SERVICE_OPENAI);
  assert.equal(activation.resendCount, 0);
  assert.deepEqual(calls[0], {
    method: 'getNumber',
    args: { service: SERVICE_OPENAI, country: COUNTRY_CODES.CHILE },
  });
  assert.deepEqual(flow.getCurrentActivation(), activation);
});

test('requestNumber falls back when first country throws NoNumbersError', async () => {
  let attempts = 0;
  const { client, calls } = makeClient({
    getNumber: async () => {
      attempts += 1;
      if (attempts === 1) throw new NoNumbersError();
      return { id: 'act-2', phone: '5511999999999' };
    },
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });

  const activation = await flow.requestNumber();

  assert.equal(activation.country, COUNTRY_CODES.BRAZIL);
  assert.equal(calls[0].args.country, COUNTRY_CODES.CHILE);
  assert.equal(calls[1].args.country, COUNTRY_CODES.BRAZIL);
});

test('requestNumber falls back when first country returns NO_NUMBERS code', async () => {
  let attempts = 0;
  const { client, calls } = makeClient({
    getNumber: async () => {
      attempts += 1;
      if (attempts === 1) return { code: 'NO_NUMBERS' };
      return { id: 'act-3', phone: '447700900123' };
    },
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });

  const activation = await flow.requestNumber();

  assert.equal(activation.country, COUNTRY_CODES.BRAZIL);
  assert.equal(calls.length, 2);
});

test('pollForCode returns code after wait responses', async () => {
  const statuses = [
    { status: 'wait' },
    { status: 'wait_retry', lastCode: '000000' },
    { status: 'ok', code: '123456' },
  ];
  let index = 0;
  let time = 0;
  const sleeps = [];
  const { client } = makeClient({
    getStatus: async () => statuses[index++],
  });
  const flow = createPhoneVerifyFlow({
    herosmsClient: client,
    pollIntervalMs: 10,
    timeoutMs: 100,
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
  });
  await flow.requestNumber();

  const code = await flow.pollForCode();

  assert.equal(code, '123456');
  assert.deepEqual(sleeps, [10, 10]);
  assert.equal(flow.getCurrentActivation().status, 'code_received');
});

test('pollForCode timeout throws PollTimeoutError / new-number-needed signal', async () => {
  let time = 0;
  const { client } = makeClient({ getStatus: async () => ({ status: 'wait' }) });
  const flow = createPhoneVerifyFlow({
    herosmsClient: client,
    pollIntervalMs: 25,
    timeoutMs: 50,
    now: () => time,
    sleep: async (ms) => { time += ms; },
  });
  await flow.requestNumber();

  await assert.rejects(() => flow.pollForCode(), (err) => {
    assert.ok(err instanceof PollTimeoutError);
    assert.ok(err instanceof NewNumberRequiredError);
    assert.equal(err.code, 'POLL_TIMEOUT');
    return true;
  });
});

test('pollForCode rejects terminal non-wait statuses immediately', async () => {
  const { client } = makeClient({ getStatus: async () => ({ status: 'cancel' }) });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  await assert.rejects(() => flow.pollForCode(), (err) => {
    assert.ok(err instanceof NewNumberRequiredError);
    assert.equal(err.reason, 'CANCEL');
    return true;
  });
});

test('resendCurrentNumber allows two resends then requires a new number without setStatus', async () => {
  const { client, calls } = makeClient();
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  const first = await flow.resendCurrentNumber();
  const second = await flow.resendCurrentNumber();
  const third = await flow.resendCurrentNumber();

  assert.deepEqual(first, { resent: true, requiresNewNumber: false, resendCount: 1 });
  assert.deepEqual(second, { resent: true, requiresNewNumber: false, resendCount: 2 });
  assert.deepEqual(third, {
    resent: false,
    requiresNewNumber: true,
    reason: 'RESEND_LIMIT',
    resendCount: 2,
  });
  const setStatusCalls = calls.filter(call => call.method === 'setStatus');
  assert.equal(setStatusCalls.length, 2);
  assert.deepEqual(setStatusCalls.map(call => call.status), [
    STATUS_CODES.REQUEST_RESEND,
    STATUS_CODES.REQUEST_RESEND,
  ]);
});

test('resendCurrentNumber does not mutate a changed activation after status update', async () => {
  let resolveResend;
  const resendPending = new Promise(resolve => { resolveResend = resolve; });
  const { client } = makeClient({
    setStatus: async (_id, status) => {
      if (status === STATUS_CODES.REQUEST_RESEND) return resendPending;
    },
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  const resendPromise = flow.resendCurrentNumber();
  const cancelResult = await flow.cancel('user stopped');

  assert.equal(cancelResult.cancelled, true);
  assert.equal(flow.getCurrentActivation(), null);
  resolveResend();
  const resendResult = await resendPromise;
  assert.deepEqual(resendResult, {
    resent: false,
    requiresNewNumber: true,
    reason: 'ACTIVATION_CHANGED',
    resendCount: 0,
  });
});

test('replaceNumber cancels old activation, gets a new number, and resets resend count', async () => {
  const numbers = [
    { id: 'old', phone: '56911111111' },
    { id: 'new', phone: '5511999999999' },
  ];
  let numberIndex = 0;
  const { client, calls } = makeClient({
    getNumber: async () => numbers[numberIndex++],
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();
  await flow.resendCurrentNumber();

  const replacement = await flow.replaceNumber('phone rejected');

  assert.equal(replacement.id, 'new');
  assert.equal(replacement.replaceReason, 'phone rejected');
  assert.equal(flow.getCurrentActivation().resendCount, 0);
  assert.ok(calls.some(call => call.method === 'setStatus' && call.id === 'old' && call.status === STATUS_CODES.CANCEL));
});

test('requestNumber cancels existing activation before replacing it', async () => {
  const numbers = [
    { id: 'old', phone: '56911111111' },
    { id: 'new', phone: '5511999999999' },
  ];
  let numberIndex = 0;
  const { client, calls } = makeClient({
    getNumber: async () => numbers[numberIndex++],
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });

  await flow.requestNumber();
  const next = await flow.requestNumber();

  assert.equal(next.id, 'new');
  assert.ok(calls.some(call => call.method === 'setStatus' && call.id === 'old' && call.status === STATUS_CODES.CANCEL));
});

test('cancel clears current activation and prevents later resend', async () => {
  const { client, calls } = makeClient();
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  const result = await flow.cancel('user stopped');

  assert.equal(result.cancelled, true);
  assert.equal(result.activation.status, 'cancelled');
  assert.equal(flow.getCurrentActivation(), null);
  await assert.rejects(() => flow.resendCurrentNumber(), NewNumberRequiredError);
  assert.ok(calls.some(call => call.method === 'setStatus' && call.status === STATUS_CODES.CANCEL));
});

test('cancel clears current activation while status update is in flight', async () => {
  let resolveSetStatus;
  const setStatusStarted = new Promise(resolve => { resolveSetStatus = resolve; });
  const { client } = makeClient({
    setStatus: async () => setStatusStarted,
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  const cancelPromise = flow.cancel('user stopped');

  assert.equal(flow.getCurrentActivation(), null);
  await assert.rejects(() => flow.resendCurrentNumber(), NewNumberRequiredError);
  resolveSetStatus();
  const result = await cancelPromise;
  assert.equal(result.cancelled, true);
});

test('cancel restores current activation if status update fails', async () => {
  const error = new Error('network failed');
  const { client } = makeClient({
    setStatus: async () => { throw error; },
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  const activation = await flow.requestNumber();

  await assert.rejects(() => flow.cancel('user stopped'), error);

  assert.deepEqual(flow.getCurrentActivation(), activation);
});

test('complete clears current activation while status update is in flight', async () => {
  let resolveSetStatus;
  const setStatusStarted = new Promise(resolve => { resolveSetStatus = resolve; });
  const { client } = makeClient({
    setStatus: async () => setStatusStarted,
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  const completePromise = flow.complete();

  assert.equal(flow.getCurrentActivation(), null);
  await assert.rejects(() => flow.resendCurrentNumber(), NewNumberRequiredError);
  resolveSetStatus();
  const result = await completePromise;
  assert.equal(result.completed, true);
});

test('complete sends COMPLETE and clears current activation', async () => {
  const { client, calls } = makeClient();
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  const result = await flow.complete();

  assert.equal(result.completed, true);
  assert.equal(result.activation.status, 'complete');
  assert.equal(flow.getCurrentActivation(), null);
  assert.ok(calls.some(call => call.method === 'setStatus' && call.status === STATUS_CODES.COMPLETE));
});

test('complete restores current activation if status update fails', async () => {
  const error = new Error('network failed');
  const { client } = makeClient({
    setStatus: async () => { throw error; },
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  const activation = await flow.requestNumber();

  await assert.rejects(() => flow.complete(), error);

  assert.deepEqual(flow.getCurrentActivation(), activation);
});

test('requestNumber skips countries whose price exceeds maxPricePerNumber', async () => {
  const priceCalls = [];
  const numberCalls = [];
  const client = {
    getPrices: async ({ service, country }) => {
      priceCalls.push({ service, country });
      const costs = {
        [COUNTRY_CODES.CHILE]: 0.8,
        [COUNTRY_CODES.BRAZIL]: 0.45,
        [COUNTRY_CODES.UK]: 0.95,
      };
      return { cost: costs[country], count: 10 };
    },
    getNumber: async ({ service, country, maxPrice }) => {
      numberCalls.push({ service, country, maxPrice });
      return { id: 'act-9', phone: '5511999999999' };
    },
    getStatus: async () => ({ status: 'wait' }),
    setStatus: async () => {},
  };

  const flow = createPhoneVerifyFlow({ herosmsClient: client, maxPricePerNumber: 0.5 });
  const activation = await flow.requestNumber();

  assert.equal(activation.country, COUNTRY_CODES.BRAZIL);
  assert.deepEqual(priceCalls.map(call => call.country), [
    COUNTRY_CODES.CHILE,
    COUNTRY_CODES.BRAZIL,
  ]);
  assert.deepEqual(numberCalls, [
    { service: SERVICE_OPENAI, country: COUNTRY_CODES.BRAZIL, maxPrice: 0.5 },
  ]);
});

test('requestNumber throws PRICE_EXCEEDED when every country exceeds maxPricePerNumber', async () => {
  const client = {
    getPrices: async ({ country }) => ({ cost: country === COUNTRY_CODES.UK ? 1.2 : 0.9, count: 10 }),
    getNumber: async () => { throw new Error('should not be called'); },
    getStatus: async () => ({ status: 'wait' }),
    setStatus: async () => {},
  };

  const flow = createPhoneVerifyFlow({ herosmsClient: client, maxPricePerNumber: 0.5 });

  await assert.rejects(() => flow.requestNumber(), (err) => {
    assert.ok(err instanceof NewNumberRequiredError);
    assert.equal(err.reason, 'PRICE_EXCEEDED');
    return true;
  });
});

test('requestNumber proceeds when getPrices fails but still passes maxPrice to getNumber', async () => {
  const numberCalls = [];
  const client = {
    getPrices: async () => { throw new Error('prices unavailable'); },
    getNumber: async ({ service, country, maxPrice }) => {
      numberCalls.push({ service, country, maxPrice });
      return { id: 'act-7', phone: '56922222222' };
    },
    getStatus: async () => ({ status: 'wait' }),
    setStatus: async () => {},
  };

  const flow = createPhoneVerifyFlow({ herosmsClient: client, maxPricePerNumber: 0.5 });
  const activation = await flow.requestNumber();

  assert.equal(activation.id, 'act-7');
  assert.equal(numberCalls[0].country, COUNTRY_CODES.CHILE);
  assert.equal(numberCalls[0].maxPrice, 0.5);
});

test('requestNumber does not pass maxPrice or call getPrices when maxPricePerNumber is unset', async () => {
  const priceCalls = [];
  const numberCalls = [];
  const client = {
    getPrices: async (args) => { priceCalls.push(args); return { cost: 99 }; },
    getNumber: async (args) => { numberCalls.push(args); return { id: 'act-x', phone: '00' }; },
    getStatus: async () => ({ status: 'wait' }),
    setStatus: async () => {},
  };

  const flow = createPhoneVerifyFlow({ herosmsClient: client });
  await flow.requestNumber();

  assert.deepEqual(priceCalls, []);
  assert.equal(numberCalls.length, 1);
  assert.equal(numberCalls[0].maxPrice, undefined);
});
