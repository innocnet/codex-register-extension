const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/mail-2925.js', 'utf8');

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
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
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

test('handlePollEmail establishes a baseline after opening from detail view and only picks mail from a later refresh', async () => {
  const bundle = extractFunction('handlePollEmail');

  const api = new Function(`
let state = 'detail';
let refreshCalls = 0;
const clickOrder = [];
const readAndDeleteCalls = [];
const seenCodes = new Set();
const deletedMailIds = new Set();
const baselineMail = { id: 'baseline', text: 'OpenAI newsletter without code' };
const newMail = { id: 'new', text: 'OpenAI verification code 654321' };

function findMailItems() {
  const items = [];
  if (state === 'detail') return items;
  if (state === 'baseline' || state === 'with-new') {
    if (!deletedMailIds.has('baseline')) {
      items.push(baselineMail);
    }
  }
  if (state === 'with-new' && !deletedMailIds.has('new')) {
    items.push(newMail);
  }
  return items;
}

function getMailItemId(item) {
  return item.id;
}

function getCurrentMailIds(items = []) {
  return new Set(items.map((item) => item.id));
}

function parseMailItemTimestamp() {
  return Date.now();
}

function matchesMailFilters(text) {
  return /openai|verification/i.test(String(text || ''));
}

function getMailItemText(item) {
  return item.text;
}

function extractVerificationCode(text) {
  const match = String(text || '').match(/(\\d{6})/);
  return match ? match[1] : null;
}

async function sleep() {}
async function sleepRandom() {}

async function returnToInbox() {
  clickOrder.push('inbox');
  if (state === 'detail') {
    state = 'baseline';
  }
  return true;
}

async function refreshInbox() {
  clickOrder.push('refresh');
  refreshCalls += 1;
  if (refreshCalls >= 2) {
    state = 'with-new';
  }
}

async function openMailAndDeleteAfterRead(item) {
  readAndDeleteCalls.push(item.id);
  deletedMailIds.add(item.id);
  return item.id === 'new' ? 'Your ChatGPT code is 654321' : 'No code here';
}

async function ensureSeenCodesSession() {}
function persistSeenCodes() {}
function log() {}

${bundle}

return {
  handlePollEmail,
  getClickOrder() {
    return clickOrder.slice();
  },
  getReadAndDeleteCalls() {
    return readAndDeleteCalls.slice();
  },
};
`)();

  const result = await api.handlePollEmail(4, {
    senderFilters: ['openai'],
    subjectFilters: ['verification'],
    maxAttempts: 2,
    intervalMs: 1,
  });

  assert.equal(result.code, '654321');
  assert.deepEqual(api.getClickOrder(), ['inbox', 'refresh', 'inbox', 'refresh']);
  assert.deepEqual(api.getReadAndDeleteCalls(), ['baseline', 'new']);
});

test('handlePollEmail ignores targetEmail and still tests any matching ChatGPT mail', async () => {
  const bundle = extractFunction('handlePollEmail');

  const api = new Function(`
let state = 'empty';
const seenCodes = new Set();
const readAndDeleteCalls = [];
const matchingMail = {
  id: 'mail-1',
  text: 'ChatGPT verification code 112233 for another.user@example.com',
};

function findMailItems() {
  return state === 'ready' ? [matchingMail] : [];
}

function getMailItemId(item) {
  return item.id;
}

function getCurrentMailIds(items = []) {
  return new Set(items.map((item) => item.id));
}

function parseMailItemTimestamp() {
  return Date.now();
}

function matchesMailFilters(text) {
  return /chatgpt|openai|verification/i.test(String(text || ''));
}

function getMailItemText(item) {
  return item.text;
}

function extractVerificationCode(text) {
  const match = String(text || '').match(/(\\d{6})/);
  return match ? match[1] : null;
}

async function sleep() {}
async function sleepRandom() {}
async function returnToInbox() {
  return true;
}
async function refreshInbox() {
  state = 'ready';
}

async function openMailAndDeleteAfterRead(item) {
  readAndDeleteCalls.push(item.id);
  return item.text;
}

async function ensureSeenCodesSession() {}
function persistSeenCodes() {}
function log() {}

${bundle}

return {
  handlePollEmail,
  getReadAndDeleteCalls() {
    return readAndDeleteCalls.slice();
  },
};
`)();

  const result = await api.handlePollEmail(8, {
    senderFilters: ['chatgpt'],
    subjectFilters: ['verification'],
    maxAttempts: 4,
    intervalMs: 1,
    targetEmail: 'expected@example.com',
  });

  assert.equal(result.code, '112233');
  assert.deepEqual(api.getReadAndDeleteCalls(), ['mail-1']);
});

test('ensureSeenCodesSession resets tried codes only when a new verification step session starts', async () => {
  const bundle = [
    extractFunction('buildSeenCodeSessionKey'),
    extractFunction('ensureSeenCodesSession'),
  ].join('\n');

  const api = new Function(`
let seenCodes = new Set(['111111']);
let seenCodeSessionKey = '';
let seenCodesReadyPromise = Promise.resolve();
const persisted = [];

async function persistSeenCodes() {
  persisted.push({
    sessionKey: seenCodeSessionKey,
    codes: [...seenCodes],
  });
}

${bundle}

return {
  ensureSeenCodesSession,
  getSeenCodes() {
    return [...seenCodes];
  },
  getSessionKey() {
    return seenCodeSessionKey;
  },
  getPersisted() {
    return persisted.slice();
  },
};
`)();

  await api.ensureSeenCodesSession(4, { filterAfterTimestamp: 1000 });
  assert.equal(api.getSessionKey(), '4:1000');
  assert.deepEqual(api.getSeenCodes(), []);

  await api.ensureSeenCodesSession(4, { filterAfterTimestamp: 1000 });
  assert.deepEqual(api.getPersisted(), [
    { sessionKey: '4:1000', codes: [] },
  ]);

  await api.ensureSeenCodesSession(8, { filterAfterTimestamp: 2000 });
  assert.equal(api.getSessionKey(), '8:2000');
  assert.deepEqual(api.getPersisted(), [
    { sessionKey: '4:1000', codes: [] },
    { sessionKey: '8:2000', codes: [] },
  ]);
});

test('openMailAndGetMessageText always returns to inbox after opening a 2925 message', async () => {
  const bundle = [
    extractFunction('returnToInbox'),
    extractFunction('openMailAndGetMessageText'),
  ].join('\n');

  const api = new Function(`
const clickOrder = [];
const mailItem = { kind: 'mail' };
let listVisible = true;
let bodyText = '';

const document = {
  body: {
    get textContent() {
      return bodyText;
    },
  },
};

function findMailItems() {
  return listVisible ? [mailItem] : [];
}

function findInboxLink() {
  return { kind: 'inbox' };
}

function simulateClick(node) {
  if (node === mailItem) {
    clickOrder.push('mail');
    listVisible = false;
    bodyText = 'Your ChatGPT code is 731091';
    return;
  }
  clickOrder.push('inbox');
  listVisible = true;
}

async function sleep() {}
async function sleepRandom() {}

${bundle}

return {
  mailItem,
  openMailAndGetMessageText,
  getClickOrder() {
    return clickOrder.slice();
  },
  isListVisible() {
    return listVisible;
  },
};
`)();

  const text = await api.openMailAndGetMessageText(api.mailItem);

  assert.match(text, /731091/);
  assert.deepEqual(api.getClickOrder(), ['mail', 'inbox']);
  assert.equal(api.isListVisible(), true);
});

test('openMailAndDeleteAfterRead deletes the opened message before returning to inbox', async () => {
  const bundle = [
    extractFunction('deleteCurrentMailboxEmail'),
    extractFunction('returnToInbox'),
    extractFunction('openMailAndDeleteAfterRead'),
  ].join('\n');

  const api = new Function(`
const calls = [];
const mailItem = { kind: 'mail' };
const deleteButton = { kind: 'delete' };
let listVisible = true;
let bodyText = '';

const document = {
  body: {
    get textContent() {
      return bodyText;
    },
  },
};

function findMailItems() {
  return listVisible ? [mailItem] : [];
}

function findDeleteButton() {
  return deleteButton;
}

function findInboxLink() {
  return { kind: 'inbox' };
}

function simulateClick(node) {
  if (node === mailItem) {
    calls.push('mail');
    listVisible = false;
    bodyText = 'Your ChatGPT code is 778899';
    return;
  }
  if (node === deleteButton) {
    calls.push('delete');
    return;
  }
  calls.push('inbox');
  listVisible = true;
}

async function sleep() {}
async function sleepRandom() {}
const console = { warn() {} };
const MAIL2925_PREFIX = '[MultiPage:mail-2925]';

${bundle}

return {
  mailItem,
  openMailAndDeleteAfterRead,
  getCalls() {
    return calls.slice();
  },
};
`)();

  const text = await api.openMailAndDeleteAfterRead(api.mailItem, 8);

  assert.match(text, /778899/);
  assert.deepEqual(api.getCalls(), ['mail', 'delete', 'inbox']);
});

test('deleteAllMailboxEmails selects all messages and clicks delete', async () => {
  const bundle = extractFunction('deleteAllMailboxEmails');

  const api = new Function(`
const calls = [];
const selectAllControl = { kind: 'select-all' };
const deleteButton = { kind: 'delete' };
let mailboxCleared = false;

async function returnToInbox() {
  calls.push('inbox');
  return true;
}

function findMailItems() {
  return mailboxCleared ? [] : [{ id: 'mail-1' }];
}

function findSelectAllControl() {
  return selectAllControl;
}

function isCheckboxChecked() {
  return false;
}

function findDeleteButton() {
  return deleteButton;
}

function simulateClick(node) {
  if (node === selectAllControl) {
    calls.push('select-all');
    return;
  }
  if (node === deleteButton) {
    calls.push('delete');
    mailboxCleared = true;
    return;
  }
  throw new Error('unexpected node');
}

async function sleep() {}
async function sleepRandom() {}

const console = { warn() {} };
const MAIL2925_PREFIX = '[MultiPage:mail-2925]';

${bundle}

return {
  deleteAllMailboxEmails,
  getCalls() {
    return calls.slice();
  },
};
`)();

  const result = await api.deleteAllMailboxEmails(4);

  assert.equal(result, true);
  assert.deepEqual(api.getCalls(), ['inbox', 'select-all', 'delete']);
});
