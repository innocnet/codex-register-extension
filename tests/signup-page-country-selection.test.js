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

function buildApi() {
  return new Function(`
const logs = [];
const clicks = [];
const HEROSMS_COUNTRY_TO_DIALING_CODE = Object.freeze({
  151: '56',
  73: '55',
  16: '44',
  187: '1',
});
const HEROSMS_COUNTRY_TO_NAME_PATTERNS = Object.freeze({
  151: /智利|chile/i,
  73: /巴西|brazil/i,
  16: /英国|united\\s*kingdom|uk/i,
  187: /美国|united\\s*states|usa|us/i,
});
const selector = {
  tagName: 'BUTTON',
  _text: '美国 +(1)',
  getAttribute(name) {
    if (name === 'role') return 'combobox';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 140, height: 40 };
  },
};
const targetOption = {
  tagName: 'DIV',
  _text: '巴西 +(55)',
  getAttribute() {
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 120, height: 32 };
  },
  scrollIntoView() {},
  dispatchEvent() {},
};
const overlay = {
  querySelectorAll() {
    return [targetOption];
  },
};
const document = {
  querySelector(selectorText) {
    if (selectorText.includes('[role="dialog"]')) return overlay;
    if (selectorText.includes('[role="listbox"]')) return null;
    if (selectorText.includes('input')) return null;
    return null;
  },
  querySelectorAll(selectorText) {
    if (selectorText.includes('[role="option"]')) return [selector, targetOption];
    return [];
  },
  dispatchEvent() {},
  elementFromPoint() {
    return targetOption;
  },
};
const location = { href: 'https://auth.openai.com/u/signup' };
const window = {
  getComputedStyle() {
    return { overflowY: 'visible', overflow: 'visible' };
  },
};
function PointerEvent(type, init = {}) {
  this.type = type;
  Object.assign(this, init);
}
function MouseEvent(type, init = {}) {
  this.type = type;
  Object.assign(this, init);
}
function log(message, level = 'info') {
  logs.push({ message, level });
}
function getActionText(el) {
  return el?._text || '';
}
function isVisibleElement(el) {
  return Boolean(el);
}
function findPhoneCountrySelector() {
  return selector;
}
function simulateClick(el) {
  clicks.push(getActionText(el) || el?.tagName || 'element');
}
async function sleep() {}
async function humanPause() {}
function throwIfStopped() {}
function fillInput() {}
${extractFunction('selectPhoneCountry')}
return { selectPhoneCountry, logs, clicks };
`)();
}

test('selectPhoneCountry reports react_state_not_updated when the visible country label does not change', async () => {
  const api = buildApi();

  const result = await api.selectPhoneCountry(73);

  assert.equal(result.selected, false);
  assert.equal(result.reason, 'react_state_not_updated');
  assert.equal(result.expectedCountry, '巴西 +(55)');
  assert.equal(result.currentCountry, '美国 +(1)');
  assert.ok(api.clicks.length >= 1);
});

test('selectPhoneCountry accepts a country option that only updates on click()', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
const HEROSMS_COUNTRY_TO_DIALING_CODE = Object.freeze({
  151: '56',
  73: '55',
  16: '44',
  187: '1',
});
const HEROSMS_COUNTRY_TO_NAME_PATTERNS = Object.freeze({
  151: /智利|chile/i,
  73: /巴西|brazil/i,
  16: /英国|united\\s*kingdom|uk/i,
  187: /美国|united\\s*states|usa|us/i,
});
const selector = {
  tagName: 'BUTTON',
  _text: '美国 +(1) 电话号码国家代码',
  getAttribute(name) {
    if (name === 'role') return 'combobox';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 140, height: 40 };
  },
};
const targetOption = {
  tagName: 'DIV',
  _text: '巴西 +(55)',
  getAttribute() {
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 120, height: 32 };
  },
  scrollIntoView() {},
  dispatchEvent() {},
  click() {
    selector._text = '巴西 +(55) 电话号码国家代码';
  },
};
const overlay = {
  querySelectorAll() {
    return [targetOption];
  },
};
const document = {
  querySelector(selectorText) {
    if (selectorText.includes('[role="dialog"]')) return overlay;
    if (selectorText.includes('[role="listbox"]')) return null;
    if (selectorText.includes('input')) return null;
    return null;
  },
  querySelectorAll(selectorText) {
    if (selectorText.includes('[role="option"]')) return [selector, targetOption];
    return [];
  },
  dispatchEvent() {},
  elementFromPoint() {
    return targetOption;
  },
};
const location = { href: 'https://auth.openai.com/u/signup' };
const window = {
  getComputedStyle() {
    return { overflowY: 'visible', overflow: 'visible' };
  },
};
function log(message, level = 'info') {
  logs.push({ message, level });
}
function getActionText(el) {
  return el?._text || '';
}
function isVisibleElement(el) {
  return Boolean(el);
}
function findPhoneCountrySelector() {
  return selector;
}
function simulateClick(el) {
  clicks.push(getActionText(el) || el?.tagName || 'element');
  if (typeof el?.click === 'function') {
    el.click();
  }
}
async function sleep() {}
async function humanPause() {}
function throwIfStopped() {}
function fillInput() {}
${extractFunction('selectPhoneCountry')}
return { selectPhoneCountry, logs, clicks };
`)();

  const result = await api.selectPhoneCountry(73);

  assert.equal(result.selected, true);
  assert.match(result.country, /巴西/);
  assert.ok(api.clicks.includes('巴西 +(55)'));
});

test('selectPhoneCountry re-reads the country selector after the DOM node is replaced', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
const HEROSMS_COUNTRY_TO_DIALING_CODE = Object.freeze({
  151: '56',
  73: '55',
  16: '44',
  187: '1',
});
const HEROSMS_COUNTRY_TO_NAME_PATTERNS = Object.freeze({
  151: /智利|chile/i,
  73: /巴西|brazil/i,
  16: /英国|united\\\\s*kingdom|uk/i,
  187: /美国|united\\\\s*states|usa|us/i,
});
const selectorBefore = {
  tagName: 'BUTTON',
  _text: '美国 +(1) 电话号码国家代码',
  getAttribute(name) {
    if (name === 'role') return 'combobox';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 140, height: 40 };
  },
};
const selectorAfter = {
  tagName: 'BUTTON',
  _text: '美国 +(1) 电话号码国家代码',
  getAttribute(name) {
    if (name === 'role') return 'combobox';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 140, height: 40 };
  },
};
const targetOption = {
  tagName: 'DIV',
  _text: '巴西 +(55)',
  getAttribute() {
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 120, height: 32 };
  },
  scrollIntoView() {},
  dispatchEvent() {},
  click() {
    selectorAfter._text = '巴西 +(55) 电话号码国家代码';
  },
};
const overlay = {
  querySelectorAll() {
    return [targetOption];
  },
};
let selectorLookupCount = 0;
const document = {
  querySelector(selectorText) {
    if (selectorText.includes('[role="dialog"]')) return overlay;
    if (selectorText.includes('[role="listbox"]')) return null;
    if (selectorText.includes('input')) return null;
    return null;
  },
  querySelectorAll(selectorText) {
    if (selectorText.includes('[role="option"]')) return [selectorBefore, targetOption];
    return [];
  },
  dispatchEvent() {},
  elementFromPoint() {
    return targetOption;
  },
};
const location = { href: 'https://auth.openai.com/u/signup' };
const window = {
  getComputedStyle() {
    return { overflowY: 'visible', overflow: 'visible' };
  },
};
function log(message, level = 'info') {
  logs.push({ message, level });
}
function getActionText(el) {
  return el?._text || '';
}
function isVisibleElement(el) {
  return Boolean(el);
}
function findPhoneCountrySelector() {
  selectorLookupCount += 1;
  return selectorLookupCount > 1 ? selectorAfter : selectorBefore;
}
function simulateClick(el) {
  clicks.push(getActionText(el) || el?.tagName || 'element');
  if (typeof el?.click === 'function') {
    el.click();
  }
}
async function sleep() {}
async function humanPause() {}
function throwIfStopped() {}
function fillInput() {}
${extractFunction('selectPhoneCountry')}
return { selectPhoneCountry, logs, clicks };
`)();

  const result = await api.selectPhoneCountry(73);

  assert.equal(result.selected, true);
  assert.match(result.country, /巴西/);
  assert.ok(api.clicks.includes('巴西 +(55)'));
});

test('selectPhoneCountry ignores a long wrapper div that happens to contain the country text', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
const HEROSMS_COUNTRY_TO_DIALING_CODE = Object.freeze({
  151: '56',
  73: '55',
  16: '44',
  187: '1',
});
const HEROSMS_COUNTRY_TO_NAME_PATTERNS = Object.freeze({
  151: /智利|chile/i,
  73: /巴西|brazil/i,
  16: /英国|united\\\\s*kingdom|uk/i,
  187: /美国|united\\\\s*states|usa|us/i,
});
const selector = {
  tagName: 'BUTTON',
  _text: '美国 +(1) 电话号码国家代码',
  getAttribute(name) {
    if (name === 'role') return 'combobox';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 140, height: 40 };
  },
};
const container = {
  tagName: 'DIV',
  _text: '登录或注册你将获得更加智能的回复并能上传文件、图片等内容。巴西 +(55) 继续',
  getAttribute() {
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 420, height: 48 };
  },
  scrollIntoView() {},
};
const targetOption = {
  tagName: 'DIV',
  _text: '巴西 +(55)',
  getAttribute() {
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { width: 120, height: 32 };
  },
  scrollIntoView() {},
  dispatchEvent() {},
  click() {
    selector._text = '巴西 +(55) 电话号码国家代码';
  },
};
const overlay = {
  querySelectorAll() {
    return [container, targetOption];
  },
};
const document = {
  querySelector(selectorText) {
    if (selectorText.includes('[role="dialog"]')) return overlay;
    if (selectorText.includes('[role="listbox"]')) return null;
    if (selectorText.includes('input')) return null;
    return null;
  },
  querySelectorAll(selectorText) {
    if (selectorText.includes('[role="option"]')) return [selector, container, targetOption];
    return [];
  },
  dispatchEvent() {},
  elementFromPoint() {
    return targetOption;
  },
};
const location = { href: 'https://auth.openai.com/u/signup' };
const window = {
  getComputedStyle() {
    return { overflowY: 'visible', overflow: 'visible' };
  },
};
function log(message, level = 'info') {
  logs.push({ message, level });
}
function getActionText(el) {
  return el?._text || '';
}
function isVisibleElement(el) {
  return Boolean(el);
}
function findPhoneCountrySelector() {
  return selector;
}
function simulateClick(el) {
  clicks.push(getActionText(el) || el?.tagName || 'element');
  if (typeof el?.click === 'function') {
    el.click();
  }
}
async function sleep() {}
async function humanPause() {}
function throwIfStopped() {}
function fillInput() {}
${extractFunction('selectPhoneCountry')}
return { selectPhoneCountry, logs, clicks };
`)();

  const result = await api.selectPhoneCountry(73);

  assert.equal(result.selected, true);
  assert.match(result.country, /巴西/);
  assert.ok(api.clicks.includes('巴西 +(55)'));
  assert.ok(!api.clicks.includes('登录或注册你将获得更加智能的回复并能上传文件、图片等内容。巴西 +(55) 继续'));
});

test('selectPhoneCountry can use debugger coordinates when DOM click does not update React state', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
const debuggerClicks = [];
const HEROSMS_COUNTRY_TO_DIALING_CODE = Object.freeze({
  151: '56',
  73: '55',
  16: '44',
  187: '1',
});
const HEROSMS_COUNTRY_TO_NAME_PATTERNS = Object.freeze({
  151: /智利|chile/i,
  73: /巴西|brazil/i,
  16: /英国|united\\\\s*kingdom|uk/i,
  187: /美国|united\\\\s*states|usa|us/i,
});
const selector = {
  tagName: 'BUTTON',
  _text: '美国 +(1) 电话号码国家代码',
  getAttribute(name) {
    if (name === 'role') return 'combobox';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { left: 10, top: 10, width: 140, height: 40 };
  },
};
const targetOption = {
  tagName: 'DIV',
  _text: '巴西 +(55)',
  getAttribute(name) {
    if (name === 'role') return 'option';
    return '';
  },
  querySelector() {
    return null;
  },
  getBoundingClientRect() {
    return { left: 20, top: 100, width: 328, height: 36 };
  },
  scrollIntoView() {},
  dispatchEvent() {},
  click() {
    // 模拟真实页面：普通 DOM click 被下拉组件忽略，不更新 React state。
  },
};
const overlay = {
  querySelectorAll() {
    return [targetOption];
  },
};
const document = {
  querySelector(selectorText) {
    if (selectorText.includes('input')) return null;
    if (selectorText.includes('[role="dialog"]')) return overlay;
    if (selectorText.includes('[role="listbox"]')) return null;
    return null;
  },
  querySelectorAll(selectorText) {
    if (selectorText.includes('[role="option"]')) return [selector, targetOption];
    return [];
  },
  dispatchEvent() {},
  elementFromPoint() {
    return targetOption;
  },
};
const location = { href: 'https://auth.openai.com/u/signup' };
const window = {
  getComputedStyle() {
    return { overflowY: 'visible', overflow: 'visible' };
  },
};
function log(message, level = 'info') {
  logs.push({ message, level });
}
function getActionText(el) {
  return el?._text || '';
}
function isVisibleElement(el) {
  return Boolean(el);
}
function findPhoneCountrySelector() {
  return selector;
}
function simulateClick(el) {
  clicks.push(getActionText(el) || el?.tagName || 'element');
  if (typeof el?.click === 'function') {
    el.click();
  }
}
async function sendBackgroundRequest(type, payload) {
  debuggerClicks.push({ type, payload });
  if (type === 'AUTH_DEBUGGER_CLICK_REQUEST') {
    selector._text = '巴西 +(55) 电话号码国家代码';
    return { ok: true };
  }
  return { error: 'unexpected request' };
}
async function sleep() {}
async function humanPause() {}
function throwIfStopped() {}
function fillInput() {}
${extractFunction('selectPhoneCountry')}
return { selectPhoneCountry, logs, clicks, debuggerClicks };
`)();

  const result = await api.selectPhoneCountry(73);

  assert.equal(result.selected, true);
  assert.match(result.country, /巴西/);
  assert.equal(api.debuggerClicks.length, 1);
  assert.equal(api.debuggerClicks[0].type, 'AUTH_DEBUGGER_CLICK_REQUEST');
  assert.equal(api.debuggerClicks[0].payload.label, '国家选择');
  assert.ok(Number.isFinite(api.debuggerClicks[0].payload.rect.centerX));
  assert.ok(api.logs.some((entry) => entry.message.includes('debugger 坐标点击')));
});
