const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/inbucket-mail.js', 'utf8');

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

test('handleMailboxPollEmail skips old Inbucket verification mail before filterAfterTimestamp and returns parsed mail timestamp', async () => {
  const bundle = extractFunction('handleMailboxPollEmail');

  const filterAfterTimestamp = 1700000000000;
  const expectedEmailTimestamp = 1700000029000;

  const api = new Function(`
let state = 'baseline';
let refreshCalls = 0;
const persisted = [];
const seenMailIds = new Set();
const opened = [];
const deleted = [];

const oldEntry = { id: 'old' };
const newEntry = { id: 'new' };

function findMailboxEntries() {
  return state === 'baseline' ? [oldEntry] : [oldEntry, newEntry];
}

function parseMailboxEntry(entry) {
  if (entry === oldEntry) {
    return {
      entry,
      dateText: 'old-ts',
      sender: 'OpenAI',
      mailbox: '',
      subject: 'OpenAI verification',
      unread: true,
      combinedText: 'OpenAI verification code 111111',
      mailId: 'old',
    };
  }
  return {
    entry,
    dateText: 'new-ts',
    sender: 'OpenAI',
    mailbox: '',
    subject: 'OpenAI verification',
    unread: true,
    combinedText: 'OpenAI verification code 222222',
    mailId: 'new',
  };
}

function getCurrentMailboxIds() {
  return state === 'baseline' ? new Set(['old']) : new Set(['old', 'new']);
}

function rowMatchesFilters(mail) {
  return {
    matched: /verification/i.test(mail.combinedText),
    mailboxMatch: false,
    code: null,
  };
}

function parseMailTimestampText(value) {
  return value === 'old-ts' ? 1699999800000 : 1700000029000;
}

function extractVerificationCode(text) {
  const match = String(text || '').match(/(\\d{6})/);
  return match ? match[1] : null;
}

async function waitForElement() {}
async function sleep() {}
async function refreshMailbox() {
  refreshCalls += 1;
  if (refreshCalls >= 3) {
    state = 'with-new';
  }
}
async function openMailboxEntry(entry) {
  opened.push(entry.id);
}
async function deleteCurrentMailboxMessage(step) {
  deleted.push(step);
}
async function persistSeenMailIds() {
  persisted.push([...seenMailIds]);
}
function log() {}

${bundle}

return {
  handleMailboxPollEmail,
  getOpened() {
    return opened.slice();
  },
  getDeleted() {
    return deleted.slice();
  },
};
`)();

  const result = await api.handleMailboxPollEmail(4, {
    senderFilters: ['openai'],
    subjectFilters: ['verification'],
    filterAfterTimestamp,
    maxAttempts: 4,
    intervalMs: 1,
  });

  assert.equal(result.code, '222222');
  assert.equal(result.emailTimestamp, expectedEmailTimestamp);
  assert.equal(result.mailId, 'new');
  assert.deepEqual(api.getOpened(), ['new']);
  assert.deepEqual(api.getDeleted(), [4]);
});
