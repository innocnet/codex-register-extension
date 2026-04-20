const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

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

function getStep5Bundle() {
  return [
    extractFunction('getStep5DirectCompletionPayload'),
    extractFunction('isStep5AllConsentText'),
    extractFunction('findStep5AllConsentCheckbox'),
    extractFunction('isStep5CheckboxChecked'),
    extractFunction('step5_fillNameBirthday'),
  ].join('\n');
}

test('step 5 clicks submit and completes immediately on birthday page', async () => {
  const step5Source = extractFunction('step5_fillNameBirthday');
  assert.ok(
    !step5Source.includes('waitForStep5SubmitOutcome('),
    'Step 5 提交后不应再等待页面结果'
  );

  const api = new Function(`
const logs = [];
const completions = [];
const clicks = [];
const selectedBirthday = {};

const nameInput = { value: '', hidden: false };
const hiddenBirthday = {
  value: '',
  hidden: false,
  dispatchEvent() {},
};
const completeButton = {
  tagName: 'BUTTON',
  textContent: '完成帐户创建',
  hidden: false,
};

const birthdaySelects = {
  '年': { label: '年', button: { hidden: false }, nativeSelect: {} },
  '月': { label: '月', button: { hidden: false }, nativeSelect: {} },
  '天': { label: '天', button: { hidden: false }, nativeSelect: {} },
};

const document = {
  querySelector(selector) {
    switch (selector) {
      case '[role="spinbutton"][data-type="year"]':
      case '[role="spinbutton"][data-type="month"]':
      case '[role="spinbutton"][data-type="day"]':
      case 'input[name="age"]':
        return null;
      case 'input[name="birthday"]':
        return hiddenBirthday;
      case 'button[type="submit"]':
        return completeButton;
      default:
        return null;
    }
  },
  querySelectorAll(selector) {
    if (selector === 'input[name="allCheckboxes"][type="checkbox"]') {
      return [];
    }
    return [];
  },
  execCommand() {},
};

const location = {
  href: 'https://auth.openai.com/u/signup/profile',
};

function Event(type, init = {}) {
  this.type = type;
  this.bubbles = Boolean(init.bubbles);
}

function log(message, level = 'info') {
  logs.push({ message, level });
}

async function waitForElement() {
  return nameInput;
}

async function humanPause() {}
async function sleep() {}

function fillInput(input, value) {
  input.value = value;
}

function findBirthdayReactAriaSelect(label) {
  return birthdaySelects[label] || null;
}

function isVisibleElement(el) {
  return Boolean(el) && !el.hidden;
}

async function setReactAriaBirthdaySelect(select, value) {
  selectedBirthday[select.label] = String(value).padStart(select.label === '年' ? 4 : 2, '0');
  if (selectedBirthday['年'] && selectedBirthday['月'] && selectedBirthday['天']) {
    hiddenBirthday.value = \`\${selectedBirthday['年']}-\${selectedBirthday['月']}-\${selectedBirthday['天']}\`;
  }
}

async function waitForElementByText() {
  throw new Error('waitForElementByText should not run in this test');
}

function simulateClick(el) {
  clicks.push(el.textContent || el.tagName || 'element');
}

function reportComplete(step, payload) {
  completions.push({ step, payload });
}

  function normalizeInlineText(text) {
    return String(text || '').replace(/\\s+/g, ' ').trim();
  }

  ${getStep5Bundle()}

return {
  async run(payload) {
    return step5_fillNameBirthday(payload);
  },
  snapshot() {
    return {
      logs,
      completions,
      clicks,
      nameValue: nameInput.value,
      birthdayValue: hiddenBirthday.value,
    };
  },
};
`)();

  const result = await api.run({
    firstName: 'Test',
    lastName: 'User',
    year: 2003,
    month: 6,
    day: 19,
  });

  const snapshot = api.snapshot();
  assert.deepStrictEqual(
    result,
    {
      skippedPostSubmitCheck: true,
      directProceedToStep6: true,
    },
    '生日模式点击提交后应直接返回完成载荷'
  );
  assert.deepStrictEqual(snapshot.completions, [
    {
      step: 5,
      payload: {
        skippedPostSubmitCheck: true,
        directProceedToStep6: true,
      },
    },
  ]);
  assert.deepStrictEqual(snapshot.clicks, ['完成帐户创建']);
  assert.equal(snapshot.nameValue, 'Test User');
  assert.equal(snapshot.birthdayValue, '2003-06-19');
  assert.ok(
    snapshot.logs.some(({ message }) => /不再等待页面结果/.test(message)),
    '日志应明确说明 Step 5 已直接完成'
  );
});
