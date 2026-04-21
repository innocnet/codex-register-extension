const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/qq-mail.js', 'utf8');

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

test('handlePollEmail skips old QQ verification mail before filterAfterTimestamp and returns parsed mail timestamp', async () => {
  const bundle = [
    extractFunction('getCurrentMailIds'),
    extractFunction('extractVerificationCode'),
    extractFunction('handlePollEmail'),
  ].join('\n');

  const filterAfterTimestamp = 1700000000000;
  const expectedEmailTimestamp = 1700000029000;

  const api = new Function(`
let state = 'baseline';
let refreshCalls = 0;

function createMailItem(id, sender, subject, digest, timestampText) {
  return {
    getAttribute(name) {
      return name === 'data-mailid' ? id : '';
    },
    querySelector(selector) {
      const map = {
        '.cmp-account-nick': { textContent: sender },
        '.mail-subject': { textContent: subject },
        '.mail-digest': { textContent: digest },
        '.mail-time': { textContent: timestampText },
        '.mail-date': { textContent: timestampText },
      };
      return map[selector] || null;
    },
  };
}

const oldMail = createMailItem('old', 'OpenAI', 'OpenAI verification', 'Code 111111', 'old-ts');
const newMail = createMailItem('new', 'OpenAI', 'OpenAI verification', 'Code 222222', 'new-ts');

const document = {
  querySelectorAll(selector) {
    if (selector === '.mail-list-page-item' || selector === '.mail-list-page-item[data-mailid]') {
      return state === 'baseline' ? [oldMail] : [oldMail, newMail];
    }
    return [];
  },
};

async function waitForElement() {}
async function sleep() {}
async function refreshInbox() {
  refreshCalls += 1;
  if (refreshCalls >= 3) {
    state = 'with-new';
  }
}

function parseMailTimestampText(value) {
  return value === 'old-ts' ? 1699999800000 : 1700000029000;
}

function extractVerificationCode(text) {
  const match = String(text || '').match(/(\\d{6})/);
  return match ? match[1] : null;
}

function log() {}

${bundle}

return { handlePollEmail };
`)();

  const result = await api.handlePollEmail(4, {
    senderFilters: ['openai'],
    subjectFilters: ['verification'],
    filterAfterTimestamp,
    maxAttempts: 4,
    intervalMs: 1,
  });

  assert.equal(result.code, '222222');
  assert.equal(result.emailTimestamp, expectedEmailTimestamp);
  assert.equal(result.mailId, 'new');
});
