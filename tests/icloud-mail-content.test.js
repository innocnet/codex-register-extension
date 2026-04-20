const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/icloud-mail.js', 'utf8');

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

test('readOpenedMailBody falls back to thread detail pane and extracts verification code', () => {
  const bundle = [
    extractFunction('normalizeText'),
    extractFunction('extractVerificationCode'),
    extractFunction('getOpenedMailBodyRoot'),
    extractFunction('readOpenedMailBody'),
  ].join('\n');

  const api = new Function(`
const detailPane = {
  innerText: '此邮件包含远程内容。 你的 ChatGPT 代码为 731091 输入此临时验证码以继续：731091',
  textContent: '此邮件包含远程内容。 你的 ChatGPT 代码为 731091 输入此临时验证码以继续：731091',
};
const document = {
  querySelector(selector) {
    if (selector.includes('.pane.thread-detail-pane')) {
      return detailPane;
    }
    return null;
  },
};
${bundle}
return { readOpenedMailBody, extractVerificationCode };
`)();

  const bodyText = api.readOpenedMailBody();
  assert.match(bodyText, /731091/);
  assert.equal(api.extractVerificationCode(bodyText), '731091');
});

test('readOpenedMailBody ignores conversation list rows when no detail pane is open', () => {
  const bundle = [
    extractFunction('normalizeText'),
    extractFunction('getOpenedMailBodyRoot'),
    extractFunction('readOpenedMailBody'),
  ].join('\n');

  const api = new Function(`
const document = {
  querySelector(selector) {
    if (selector === '.mail-message-defaults, .pane.thread-detail-pane') {
      return null;
    }
    throw new Error('unexpected selector: ' + selector);
  },
};
${bundle}
return { readOpenedMailBody };
`)();

  assert.equal(api.readOpenedMailBody(), '');
});

test('isThreadItemSelected follows the selected thread-list-item instead of the content container itself', () => {
  const bundle = [
    extractFunction('normalizeText'),
    extractFunction('getThreadItemMetadata'),
    extractFunction('buildItemSignature'),
    extractFunction('getThreadListItemRoot'),
    extractFunction('isThreadItemSelected'),
  ].join('\n');

  const selectedRoot = {
    getAttribute(name) {
      return name === 'aria-selected' ? 'true' : '';
    },
    className: 'thread-list-item ic-z3c00x',
  };
  const selectedItem = {
    closest() {
      return selectedRoot;
    },
    getAttribute() {
      return '';
    },
    querySelector(selector) {
      const map = {
        '.thread-participants': { textContent: 'OpenAI' },
        '.thread-subject': { textContent: '你的 ChatGPT 代码为 731091' },
        '.thread-preview': { textContent: '输入此临时验证码以继续：731091' },
        '.thread-timestamp': { textContent: '下午1:35' },
      };
      return map[selector] || null;
    },
  };
  const staleRoot = {
    getAttribute() {
      return '';
    },
    className: 'thread-list-item ic-z3c00x',
  };
  const staleItem = {
    closest() {
      return staleRoot;
    },
    getAttribute() {
      return '';
    },
    querySelector(selector) {
      const map = {
        '.thread-participants': { textContent: 'JetBrains Sales' },
        '.thread-subject': { textContent: '旧邮件' },
        '.thread-preview': { textContent: '旧摘要' },
        '.thread-timestamp': { textContent: '2026/3/4' },
      };
      return map[selector] || null;
    },
  };

  const api = new Function(`
let threadItems = [];
function collectThreadItems() {
  return threadItems;
}
${bundle}
return {
  buildItemSignature,
  isThreadItemSelected,
  setThreadItems(next) {
    threadItems = next;
  },
};
`)();

  api.setThreadItems([selectedItem, staleItem]);
  assert.equal(api.isThreadItemSelected(staleItem, api.buildItemSignature(selectedItem)), true);
  assert.equal(api.isThreadItemSelected(staleItem, api.buildItemSignature(staleItem)), false);
});
