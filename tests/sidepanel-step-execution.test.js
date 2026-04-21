const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractStepsListClickHandler() {
  const marker = "stepsList?.addEventListener('click', async (event) => {";
  const start = sidepanelSource.indexOf(marker);
  if (start < 0) {
    throw new Error('missing stepsList click handler');
  }

  const functionStart = sidepanelSource.indexOf('async (event) => {', start);
  if (functionStart < 0) {
    throw new Error('missing handler function start');
  }

  const braceStart = sidepanelSource.indexOf('{', functionStart);
  let depth = 0;
  let end = braceStart;
  for (; end < sidepanelSource.length; end += 1) {
    const ch = sidepanelSource[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return sidepanelSource.slice(functionStart, end);
}

function createApi() {
  const clickHandlerSource = extractStepsListClickHandler();

  return new Function(`
const sentMessages = [];
const savedSettingsCalls = [];
const toasts = [];
let latestState = { customPassword: '', email: null, mailProvider: '163' };
const inputPassword = { value: '' };
const inputEmail = { value: '' };
const inputEmailPrefix = { value: '' };
const selectMailProvider = { value: '163' };
const GMAIL_PROVIDER = 'gmail';

async function maybeTakeoverAutoRun() { return true; }
async function saveSettings(options = {}) {
  savedSettingsCalls.push(options);
}
function syncLatestState(nextState) {
  latestState = { ...latestState, ...nextState };
}
function isLuckmailProvider() { return false; }
function usesGeneratedAliasMailProvider(provider = selectMailProvider.value) {
  return ['gmail', '2925'].includes(String(provider || '').trim().toLowerCase());
}
function isCustomMailProvider() { return false; }
function validateCurrentRegistrationEmail() { return true; }
function buildManagedAliasBaseEmailPayload() {
  return {
    gmailBaseEmail: '',
    mail2925BaseEmail: inputEmailPrefix.value.trim(),
    emailPrefix: '',
  };
}
function showToast(message, level) {
  toasts.push({ message, level });
}
async function fetchGeneratedEmail() {
  throw new Error('unexpected fetchGeneratedEmail call');
}
const chrome = {
  runtime: {
    async sendMessage(message) {
      sentMessages.push(message);
      return { ok: true };
    },
  },
};

const onStepButtonClick = ${clickHandlerSource};

return {
  onStepButtonClick,
  inputEmail,
  inputEmailPrefix,
  inputPassword,
  selectMailProvider,
  getSentMessages() { return sentMessages.slice(); },
  getSavedSettingsCalls() { return savedSettingsCalls.slice(); },
  getToasts() { return toasts.slice(); },
  setLatestState(nextState) { latestState = { ...latestState, ...nextState }; },
};
`)();
}

function createStepEvent(step) {
  return {
    target: {
      closest(selector) {
        if (selector !== '.step-btn') {
          return null;
        }
        return { dataset: { step: String(step) } };
      },
    },
  };
}

test('manual step 2 sends current email to background when registration email is already present in the UI', async () => {
  const api = createApi();
  api.inputEmail.value = 'user@example.com';

  await api.onStepButtonClick(createStepEvent(2));

  assert.deepStrictEqual(api.getSentMessages(), [
    {
      type: 'EXECUTE_STEP',
      source: 'sidepanel',
      payload: { step: 2, email: 'user@example.com' },
    },
  ]);
  assert.deepStrictEqual(api.getSavedSettingsCalls(), []);
  assert.deepStrictEqual(api.getToasts(), []);
});

test('manual step 2 forwards managed-alias base email to background when delegating generation', async () => {
  const api = createApi();
  api.selectMailProvider.value = '2925';
  api.inputEmail.value = '';
  api.inputEmailPrefix.value = 'demo@2925.com';

  await api.onStepButtonClick(createStepEvent(2));

  assert.deepStrictEqual(api.getSavedSettingsCalls(), [{ silent: true }]);
  assert.deepStrictEqual(api.getSentMessages(), [
    {
      type: 'EXECUTE_STEP',
      source: 'sidepanel',
      payload: {
        step: 2,
        gmailBaseEmail: '',
        mail2925BaseEmail: 'demo@2925.com',
        emailPrefix: '',
      },
    },
  ]);
  assert.deepStrictEqual(api.getToasts(), []);
});
