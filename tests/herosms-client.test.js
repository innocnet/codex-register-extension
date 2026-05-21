const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHerosmsClient,
  HerosmsError,
  NoNumbersError,
  NoBalanceError,
  AuthenticationError,
  BannedError,
  DEFAULT_BASE_URL,
  COUNTRY_CODES,
  SERVICE_OPENAI,
  STATUS_CODES,
} = require('../background/herosms-client.js');

function makeFetchStub(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses[i] || responses[responses.length - 1];
    i += 1;
    if (next instanceof Error) throw next;
    return {
      ok: true,
      text: async () => String(next),
    };
  };
  return { fetchImpl, calls };
}

test('urlFor builds query string with api_key, action and extras', () => {
  const { fetchImpl } = makeFetchStub([]);
  const client = createHerosmsClient({ apiKey: 'KEY123', fetchImpl });
  const url = client.urlFor('getNumber', { service: 'oi', country: 151 });
  assert.match(url, /^https:\/\/hero-sms\.com\/stubs\/handler_api\.php\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('api_key'), 'KEY123');
  assert.equal(parsed.searchParams.get('action'), 'getNumber');
  assert.equal(parsed.searchParams.get('service'), 'oi');
  assert.equal(parsed.searchParams.get('country'), '151');
});

test('getNumber returns {id, phone} on ACCESS_NUMBER response', async () => {
  const { fetchImpl, calls } = makeFetchStub(['ACCESS_NUMBER:9876:56912345678']);
  const client = createHerosmsClient({ apiKey: 'KEY', fetchImpl });
  const result = await client.getNumber({ service: 'oi', country: 151 });
  assert.deepEqual(result, { id: '9876', phone: '56912345678' });
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('action'), 'getNumber');
  assert.equal(parsed.searchParams.get('service'), 'oi');
});

test('getBalance returns balance from ACCESS_BALANCE response', async () => {
  const { fetchImpl, calls } = makeFetchStub(['ACCESS_BALANCE:12.34']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getBalance();
  assert.deepEqual(result, { balance: '12.34' });
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('action'), 'getBalance');
});

test('getPrices returns {cost,count} for service+country JSON response', async () => {
  const payload = JSON.stringify({ '151': { oi: { cost: 0.45, count: 12 } } });
  const { fetchImpl, calls } = makeFetchStub([payload]);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getPrices({ service: 'oi', country: 151 });
  assert.equal(result.cost, 0.45);
  assert.equal(result.count, 12);
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('action'), 'getPrices');
  assert.equal(parsed.searchParams.get('service'), 'oi');
  assert.equal(parsed.searchParams.get('country'), '151');
});

test('getPrices throws MISSING_PRICE when country/service entry is absent', async () => {
  const payload = JSON.stringify({ '73': { wa: { cost: 1 } } });
  const { fetchImpl } = makeFetchStub([payload]);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getPrices({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'MISSING_PRICE');
    return true;
  });
});

test('getPrices propagates BAD_KEY / NO_BALANCE / BANNED errors', async () => {
  const { fetchImpl: badKey } = makeFetchStub(['BAD_KEY']);
  await assert.rejects(
    () => createHerosmsClient({ apiKey: 'K', fetchImpl: badKey }).getPrices({ service: 'oi', country: 151 }),
    (err) => err.code === 'BAD_KEY'
  );

  const { fetchImpl: noBal } = makeFetchStub(['NO_BALANCE']);
  await assert.rejects(
    () => createHerosmsClient({ apiKey: 'K', fetchImpl: noBal }).getPrices({ service: 'oi', country: 151 }),
    (err) => err.code === 'NO_BALANCE'
  );

  const { fetchImpl: banned } = makeFetchStub(['BANNED:1735689600']);
  await assert.rejects(
    () => createHerosmsClient({ apiKey: 'K', fetchImpl: banned }).getPrices({ service: 'oi', country: 151 }),
    (err) => err.code === 'BANNED'
  );
});

test('getNumber throws NoNumbersError on NO_NUMBERS', async () => {
  const { fetchImpl } = makeFetchStub(['NO_NUMBERS']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'NO_NUMBERS');
    assert.equal(err.name, 'NoNumbersError');
    return true;
  });
});

test('getNumber throws AuthenticationError on BAD_KEY', async () => {
  const { fetchImpl } = makeFetchStub(['BAD_KEY']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'BAD_KEY');
    return true;
  });
});

test('getNumber throws NoBalanceError on NO_BALANCE', async () => {
  const { fetchImpl } = makeFetchStub(['NO_BALANCE']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'NO_BALANCE');
    return true;
  });
});

test('getNumber throws BannedError with until timestamp', async () => {
  const { fetchImpl } = makeFetchStub(['BANNED:1735689600']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'BANNED');
    assert.equal(err.until, 1735689600);
    return true;
  });
});

test('getStatus returns {status:"ok", code} on STATUS_OK', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_OK:485712']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'ok', code: '485712' });
});

test('getStatus returns {status:"wait"} on STATUS_WAIT_CODE', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_WAIT_CODE']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'wait' });
});

test('getStatus returns {status:"wait_retry"} with lastCode on STATUS_WAIT_RETRY', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_WAIT_RETRY:000111']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'wait_retry', lastCode: '000111' });
});

test('getStatus returns {status:"cancel"} on STATUS_CANCEL', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_CANCEL']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'cancel' });
});

test('setStatus sends action=setStatus with status and id', async () => {
  const { fetchImpl, calls } = makeFetchStub(['ACCESS_READY']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await client.setStatus('9999', 3);
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('action'), 'setStatus');
  assert.equal(parsed.searchParams.get('id'), '9999');
  assert.equal(parsed.searchParams.get('status'), '3');
});

test('setStatus rejects on unknown response', async () => {
  const { fetchImpl } = makeFetchStub(['NO_ACTIVATION']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.setStatus('1', 6));
});

test('setStatus accepts ACCESS_READY / ACCESS_RETRY_GET / ACCESS_ACTIVATION / ACCESS_CANCEL', async () => {
  const replies = ['ACCESS_READY', 'ACCESS_RETRY_GET', 'ACCESS_ACTIVATION', 'ACCESS_CANCEL'];
  for (const reply of replies) {
    const { fetchImpl } = makeFetchStub([reply]);
    const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
    await client.setStatus('1', 1);
  }
});

test('exports country / service / status constants used by phone-verify-flow', () => {
  assert.equal(COUNTRY_CODES.CHILE, 151);
  assert.equal(COUNTRY_CODES.BRAZIL, 73);
  assert.equal(COUNTRY_CODES.UK, 16);
  assert.equal(SERVICE_OPENAI, 'oi');
  assert.equal(STATUS_CODES.SMS_SENT, 1);
  assert.equal(STATUS_CODES.REQUEST_RESEND, 3);
  assert.equal(STATUS_CODES.COMPLETE, 6);
  assert.equal(STATUS_CODES.CANCEL, 8);
});
