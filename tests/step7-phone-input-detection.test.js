const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
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

function makeInput({ type = 'text', name = '', id = '', placeholder = '', ariaLabel = '', autocomplete = '', visible = true }) {
  return {
    _attrs: { type, name, id, placeholder, 'aria-label': ariaLabel, autocomplete },
    _visible: visible,
    id,
    getAttribute(key) {
      return this._attrs[key] || '';
    },
  };
}

function buildApi({ selectorHit, allInputs, isPhoneLoginUrl }) {
  const fakeLocationHref = isPhoneLoginUrl
    ? 'https://auth.openai.com/log-in?usernameKind=phone_number'
    : 'https://auth.openai.com/log-in';

  return new Function(`
const location = { href: ${JSON.stringify(fakeLocationHref)} };
const selectorHit = ${selectorHit ? 'arguments[0][0]' : 'null'};
const allInputs = arguments[0][1];
const document = {
  querySelector(selector) {
    return selectorHit;
  },
  querySelectorAll(selector) {
    if (selector === 'input') return allInputs;
    return [];
  },
};
function isVisibleElement(el) {
  return Boolean(el && el._visible);
}
${extractFunction('findPhoneLoginInput')}
return findPhoneLoginInput;
`)([selectorHit, allInputs]);
}

test('findPhoneLoginInput selector covers __reservedForPhoneNumberInput_tel via PhoneNumberInput token', () => {
  const body = extractFunction('findPhoneLoginInput');
  assert.match(body, /name\*="PhoneNumberInput" i/);
  assert.match(body, /placeholder\*="电话" i/);
});

test('findPhoneLoginInput returns the selector hit when it is visible', () => {
  const phoneInput = makeInput({ type: 'tel', name: '__reservedForPhoneNumberInput_tel', id: 'tel', placeholder: '电话号码' });
  const find = buildApi({ selectorHit: phoneInput, allInputs: [phoneInput], isPhoneLoginUrl: true });
  assert.equal(find(), phoneInput);
});

test('findPhoneLoginInput falls back to the only visible input when URL is phone_number and selector misses', () => {
  const phoneInput = makeInput({ type: 'text', name: 'foo', id: 'tel', placeholder: '' });
  const find = buildApi({ selectorHit: null, allInputs: [phoneInput], isPhoneLoginUrl: true });
  assert.equal(find(), phoneInput);
});

test('findPhoneLoginInput picks the type=tel input among multiple visible inputs when URL is phone_number', () => {
  const countryInput = makeInput({ type: 'text', name: 'country', id: 'country' });
  const phoneInput = makeInput({ type: 'tel', name: '', id: 'tel' });
  const find = buildApi({ selectorHit: null, allInputs: [countryInput, phoneInput], isPhoneLoginUrl: true });
  assert.equal(find(), phoneInput);
});

test('findPhoneLoginInput returns null when not on phone login URL and selector misses', () => {
  const phoneInput = makeInput({ type: 'tel', name: 'tel', id: 'tel' });
  const find = buildApi({ selectorHit: null, allInputs: [phoneInput], isPhoneLoginUrl: false });
  assert.equal(find(), null);
});
