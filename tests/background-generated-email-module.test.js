const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports generated email helper module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /importScripts\([\s\S]*'background\/generated-email-helpers\.js'/);
});

test('generated email helper module exposes a factory', () => {
  const source = fs.readFileSync('background/generated-email-helpers.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageGeneratedEmailHelpers;`)(globalScope);

  assert.equal(typeof api?.createGeneratedEmailHelpers, 'function');
});

test('fetchGeneratedEmail uses managed alias branch for 2925 provider instead of Duck', async () => {
  const source = fs.readFileSync('background/generated-email-helpers.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageGeneratedEmailHelpers;`)(globalScope);

  const calls = [];
  const helpers = api.createGeneratedEmailHelpers({
    DUCK_AUTOFILL_URL: 'https://duckduckgo.com/email/autofill',
    CLOUDFLARE_TEMP_EMAIL_GENERATOR: 'cloudflare-temp-email',
    addLog: async () => {},
    buildGeneratedAliasEmail: (state) => {
      calls.push({ type: 'buildGeneratedAliasEmail', state });
      return 'demoabc123@2925.com';
    },
    buildCloudflareTempEmailHeaders: () => ({}),
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
    fetchIcloudHideMyEmail: async () => {
      throw new Error('unexpected icloud fetch');
    },
    getCloudflareTempEmailAddressFromResponse: () => '',
    getCloudflareTempEmailConfig: () => ({ baseUrl: 'https://example.com', adminPassword: 'x' }),
    getState: async () => ({ mailProvider: '163', emailGenerator: 'duck' }),
    joinCloudflareTempEmailUrl: (base, path) => `${base}${path}`,
    normalizeCloudflareDomain: (value) => value,
    normalizeCloudflareTempEmailAddress: (value) => value,
    normalizeEmailGenerator: (value) => String(value || '').trim().toLowerCase(),
    isGeneratedAliasProvider: (provider) => String(provider || '').trim().toLowerCase() === '2925',
    reuseOrCreateTab: async () => {
      calls.push({ type: 'reuseOrCreateTab' });
      return 1;
    },
    sendToContentScript: async () => {
      calls.push({ type: 'sendToContentScript' });
      return { email: 'duck@example.com' };
    },
    setEmailState: async (email) => {
      calls.push({ type: 'setEmailState', email });
    },
    throwIfStopped: () => {},
  });

  const email = await helpers.fetchGeneratedEmail(
    { mailProvider: '163', emailGenerator: 'duck' },
    { mailProvider: '2925', generator: 'duck', mail2925BaseEmail: 'demo@2925.com' }
  );

  assert.equal(email, 'demoabc123@2925.com');
  assert.deepStrictEqual(calls, [
    {
      type: 'buildGeneratedAliasEmail',
      state: {
        mailProvider: '2925',
        emailGenerator: 'duck',
        mail2925BaseEmail: 'demo@2925.com',
      },
    },
    {
      type: 'setEmailState',
      email: 'demoabc123@2925.com',
    },
  ]);
});
