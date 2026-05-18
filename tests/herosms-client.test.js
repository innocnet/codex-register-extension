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
