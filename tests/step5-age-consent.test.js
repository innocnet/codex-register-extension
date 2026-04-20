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

test('step 5 clicks the top all-consent checkbox on age page before submit', async () => {
  const api = new Function(`
const logs = [];
const completions = [];
const clicks = [];

const nameInput = { value: '', hidden: false };
const ageInput = { value: '', hidden: false };
const completeButton = {
  tagName: 'BUTTON',
  textContent: '\\u5b8c\\u6210\\u8d26\\u6237\\u521b\\u5efa',
  hidden: false,
};
const allConsentLabel = {
  hidden: false,
  textContent: '\\u6211\\u540c\\u610f\\u4ee5\\u4e0b\\u6240\\u6709\\u5404\\u9879',
  closest() {
    return null;
  },
};
const allConsentCheckbox = {
  checked: false,
  hidden: true,
  name: 'allCheckboxes',
  type: 'checkbox',
  click() {
    this.checked = true;
  },
  getAttribute(name) {
    if (name === 'name') return this.name;
    if (name === 'type') return this.type;
    return '';
  },
  closest(selector) {
    if (selector === 'label') return allConsentLabel;
    return null;
  },
};

const document = {
  querySelector(selector) {
    switch (selector) {
      case '[role="spinbutton"][data-type="year"]':
      case '[role="spinbutton"][data-type="month"]':
      case '[role="spinbutton"][data-type="day"]':
      case 'input[name="birthday"]':
        return null;
      case 'input[name="age"]':
        return ageInput;
      case 'button[type="submit"]':
        return completeButton;
      default:
        return null;
    }
  },
  querySelectorAll(selector) {
    if (selector === 'input[name="allCheckboxes"][type="checkbox"]') {
      return [allConsentCheckbox];
    }
    if (selector === 'input[type="checkbox"]') {
      return [allConsentCheckbox];
    }
    return [];
  },
  execCommand() {},
};

const location = {
  href: 'https://auth.openai.com/u/signup/profile',
};

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

function findBirthdayReactAriaSelect() {
  return null;
}

function isVisibleElement(el) {
  return Boolean(el) && !el.hidden;
}

async function setReactAriaBirthdaySelect() {
  throw new Error('setReactAriaBirthdaySelect should not run in age-mode test');
}

async function waitForElementByText() {
  throw new Error('waitForElementByText should not run in this test');
}

function simulateClick(el) {
  clicks.push(el.textContent || el.tagName || 'element');
  if (el === allConsentLabel || el === allConsentCheckbox) {
    allConsentCheckbox.checked = true;
  }
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
      ageValue: ageInput.value,
      consentChecked: allConsentCheckbox.checked,
    };
  },
};
`)();

  const result = await api.run({
    firstName: 'Mia',
    lastName: 'Harris',
    age: 19,
  });

  const snapshot = api.snapshot();
  assert.deepStrictEqual(result, {
    skippedPostSubmitCheck: true,
    directProceedToStep6: true,
    ageMode: true,
  });
  assert.equal(snapshot.nameValue, 'Mia Harris');
  assert.equal(snapshot.ageValue, '19');
  assert.equal(snapshot.consentChecked, true);
  assert.deepStrictEqual(snapshot.clicks, [
    '\u6211\u540c\u610f\u4ee5\u4e0b\u6240\u6709\u5404\u9879',
    '\u5b8c\u6210\u8d26\u6237\u521b\u5efa',
  ]);
  assert.deepStrictEqual(snapshot.completions, [
    {
      step: 5,
      payload: {
        skippedPostSubmitCheck: true,
        directProceedToStep6: true,
        ageMode: true,
      },
    },
  ]);
});
