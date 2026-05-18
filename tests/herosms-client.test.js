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
