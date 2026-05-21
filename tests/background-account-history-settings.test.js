const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

test('background account history settings are normalized independently from hotmail service mode', () => {
  const bundle = [
    extractFunction('normalizeHotmailLocalBaseUrl'),
    extractFunction('normalizeAccountRunHistoryHelperBaseUrl'),
    extractFunction('normalizeVerificationResendCount'),
    extractFunction('normalizeVerificationPollIntervalMs'),
    extractFunction('normalizeVerificationPollMaxAttempts'),
    extractFunction('normalizePersistentSettingValue'),
  ].join('\n');

  const api = new Function(`
const DEFAULT_HOTMAIL_LOCAL_BASE_URL = 'http://127.0.0.1:17373';
const DEFAULT_ACCOUNT_RUN_HISTORY_HELPER_BASE_URL = DEFAULT_HOTMAIL_LOCAL_BASE_URL;
const DEFAULT_HOTMAIL_REMOTE_BASE_URL = '';
const DEFAULT_VERIFICATION_RESEND_COUNT = 4;
const DEFAULT_SUB2API_PROXY_NAME = '';
const HOTMAIL_SERVICE_MODE_REMOTE = 'remote';
const HOTMAIL_SERVICE_MODE_LOCAL = 'local';
const VERIFICATION_RESEND_COUNT_MIN = 0;
const VERIFICATION_RESEND_COUNT_MAX = 20;
const VERIFICATION_POLL_INTERVAL_MIN_MS = 1000;
const VERIFICATION_POLL_INTERVAL_MAX_MS = 60000;
const VERIFICATION_POLL_MAX_ATTEMPTS_MIN = 1;
const VERIFICATION_POLL_MAX_ATTEMPTS_MAX = 60;
const PERSISTED_SETTING_DEFAULTS = {
  autoStepDelaySeconds: null,
  signupVerificationPollIntervalMs: 20000,
  signupVerificationPollMaxAttempts: 6,
  loginVerificationPollIntervalMs: 20000,
  loginVerificationPollMaxAttempts: 6,
  mailProvider: '163',
  emailGenerator: 'icloud',
  herosmsApiKey: '',
  herosmsCountryPreference: 'auto',
  herosmsCountries: [
    { code: 151, enabled: true },
    { code: 73, enabled: true },
    { code: 16, enabled: true },
  ],
  herosmsMaxPricePerNumber: 0.5,
};
function normalizePanelMode(value) { return value === 'sub2api' ? 'sub2api' : 'cpa'; }
function normalizeLocalCpaStep9Mode(value) { return value === 'bypass' ? 'bypass' : 'submit'; }
function normalizeAutoRunFallbackThreadIntervalMinutes(value) { return Number(value) || 0; }
function normalizeAutoRunDelayMinutes(value) { return Number(value) || 30; }
function normalizeAutoStepDelaySeconds(value) { return value == null || value === '' ? null : Number(value); }
function normalizeMailProvider(value) { return String(value || '').trim().toLowerCase() || '163'; }
function normalizeMail2925Mode(value) { return String(value || '').trim().toLowerCase() === 'receive' ? 'receive' : 'provide'; }
function normalizeEmailGenerator(value) { const normalized = String(value || '').trim().toLowerCase(); return normalized === 'duck' ? 'duck' : (normalized || 'icloud'); }
function normalizeHerosmsCountryPreference(value) { const normalized = String(value || '').trim().toLowerCase(); return normalized === '151' ? 'chile' : (normalized === 'br' ? 'brazil' : 'auto'); }
function normalizeHerosmsMaxPricePerNumber(value) {
  if (value === '' || value === null || value === undefined) return PERSISTED_SETTING_DEFAULTS.herosmsMaxPricePerNumber;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return PERSISTED_SETTING_DEFAULTS.herosmsMaxPricePerNumber;
  return Math.round(numeric * 10000) / 10000;
}
function normalizeHerosmsCountries(value) {
  const fallback = PERSISTED_SETTING_DEFAULTS.herosmsCountries;
  if (!Array.isArray(value)) return fallback.map(entry => ({ code: entry.code, enabled: Boolean(entry.enabled) }));
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!entry) continue;
    const code = Number(typeof entry === 'object' ? entry.code : entry);
    if (!Number.isFinite(code) || code < 0 || seen.has(code)) continue;
    seen.add(code);
    const enabled = typeof entry === 'object' && entry.enabled !== undefined ? Boolean(entry.enabled) : true;
    out.push({ code: Math.floor(code), enabled });
  }
  return out.length ? out : fallback.map(entry => ({ code: entry.code, enabled: Boolean(entry.enabled) }));
}
function normalizeIcloudHost(value) { const normalized = String(value || '').trim().toLowerCase(); return normalized === 'icloud.com' || normalized === 'icloud.com.cn' ? normalized : ''; }
function normalizeHotmailServiceMode(value) { return String(value || '').trim().toLowerCase() === 'remote' ? 'remote' : 'local'; }
function normalizeHotmailRemoteBaseUrl(value) { return String(value || '').trim(); }
function normalizeCloudflareDomain(value) { return String(value || '').trim(); }
function normalizeCloudflareDomains(value) { return Array.isArray(value) ? value : []; }
function normalizeCloudflareTempEmailBaseUrl(value) { return String(value || '').trim(); }
function normalizeCloudflareTempEmailReceiveMailbox(value) { return String(value || '').trim().toLowerCase(); }
function normalizeCloudflareTempEmailDomain(value) { return String(value || '').trim(); }
function normalizeCloudflareTempEmailDomains(value) { return Array.isArray(value) ? value : []; }
function normalizeHotmailAccounts(value) { return Array.isArray(value) ? value : []; }
${bundle}
return {
  normalizeAccountRunHistoryHelperBaseUrl,
  normalizePersistentSettingValue,
};
  `)();

  assert.equal(api.normalizePersistentSettingValue('accountRunHistoryTextEnabled', 1), true);
  assert.equal(api.normalizePersistentSettingValue('verificationResendCount', '7'), 7);
  assert.equal(api.normalizePersistentSettingValue('verificationResendCount', '-1'), 0);
  assert.equal(api.normalizePersistentSettingValue('signupVerificationPollIntervalMs', '9000'), 9000);
  assert.equal(api.normalizePersistentSettingValue('signupVerificationPollMaxAttempts', '12'), 12);
  assert.equal(api.normalizePersistentSettingValue('loginVerificationPollIntervalMs', '11000'), 11000);
  assert.equal(api.normalizePersistentSettingValue('loginVerificationPollMaxAttempts', '9'), 9);
  assert.equal(api.normalizePersistentSettingValue('signupVerificationPollIntervalMs', ''), 20000);
  assert.equal(api.normalizePersistentSettingValue('signupVerificationPollMaxAttempts', ''), 6);
  assert.equal(api.normalizePersistentSettingValue('loginVerificationPollIntervalMs', ''), 20000);
  assert.equal(api.normalizePersistentSettingValue('loginVerificationPollMaxAttempts', ''), 6);
  assert.equal(
    api.normalizePersistentSettingValue('accountRunHistoryHelperBaseUrl', 'http://127.0.0.1:17373/append-account-log'),
    'http://127.0.0.1:17373'
  );
  assert.equal(
    api.normalizePersistentSettingValue('accountRunHistoryHelperBaseUrl', 'http://127.0.0.1:17373/sync-account-run-records'),
    'http://127.0.0.1:17373'
  );
  assert.equal(
    api.normalizeAccountRunHistoryHelperBaseUrl(''),
    'http://127.0.0.1:17373'
  );
  assert.equal(
    api.normalizePersistentSettingValue('sub2apiDefaultProxyName', ''),
    ''
  );
  assert.equal(
    api.normalizePersistentSettingValue('sub2apiDefaultProxyName', ' proxy-a '),
    'proxy-a'
  );
  assert.equal(api.normalizePersistentSettingValue('emailGenerator', ''), 'icloud');
  assert.equal(api.normalizePersistentSettingValue('herosmsApiKey', ' key '), 'key');
  assert.equal(api.normalizePersistentSettingValue('herosmsCountryPreference', '151'), 'chile');
  assert.equal(api.normalizePersistentSettingValue('herosmsCountryPreference', 'br'), 'brazil');
  assert.equal(api.normalizePersistentSettingValue('herosmsCountryPreference', 'unknown'), 'auto');
  assert.equal(api.normalizePersistentSettingValue('herosmsMaxPricePerNumber', ''), 0.5);
  assert.equal(api.normalizePersistentSettingValue('herosmsMaxPricePerNumber', '0.42'), 0.42);
  assert.equal(api.normalizePersistentSettingValue('herosmsMaxPricePerNumber', '-3'), 0.5);
  assert.equal(api.normalizePersistentSettingValue('herosmsMaxPricePerNumber', 'NaN'), 0.5);
  assert.equal(api.normalizePersistentSettingValue('herosmsMaxPricePerNumber', '0'), 0);
  assert.deepEqual(
    api.normalizePersistentSettingValue('herosmsCountries', [
      { code: 73, enabled: true },
      { code: 151, enabled: false },
      { code: '999', enabled: true },
      { code: 73, enabled: true },
    ]),
    [
      { code: 73, enabled: true },
      { code: 151, enabled: false },
      { code: 999, enabled: true },
    ]
  );
  const defaultCountries = api.normalizePersistentSettingValue('herosmsCountries', undefined);
  assert.equal(defaultCountries[0].code, 151);
  assert.equal(defaultCountries[0].enabled, true);
});
