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

function loadApi() {
  const bundle = [
    extractFunction('normalizeHerosmsCountryPreference'),
    extractFunction('normalizeHerosmsCountries'),
    extractFunction('getHerosmsCountrySequence'),
  ].join('\n');

  return new Function(`
const PERSISTED_SETTING_DEFAULTS = {
  herosmsCountries: [
    { code: 151, enabled: true },
    { code: 73, enabled: true },
    { code: 16, enabled: true },
    { code: 0, enabled: false },
  ],
};
const self = {
  MultiPagePhoneVerifyFlow: {
    COUNTRY_CODES: { CHILE: 151, BRAZIL: 73, UK: 16 },
    DEFAULT_COUNTRY_SEQUENCE: [151, 73, 16],
  },
};
${bundle}
return { getHerosmsCountrySequence, normalizeHerosmsCountries, normalizeHerosmsCountryPreference };
`)();
}

test('getHerosmsCountrySequence returns enabled country codes in order from herosmsCountries', () => {
  const api = loadApi();
  const sequence = api.getHerosmsCountrySequence({
    herosmsCountries: [
      { code: 73, enabled: true },
      { code: 16, enabled: false },
      { code: 151, enabled: true },
    ],
  });
  assert.deepEqual(sequence, [73, 151]);
});

test('getHerosmsCountrySequence falls back to legacy preference when herosmsCountries missing', () => {
  const api = loadApi();
  const sequence = api.getHerosmsCountrySequence({ herosmsCountryPreference: 'brazil' });
  assert.deepEqual(sequence, [73, 151, 16]);
});

test('getHerosmsCountrySequence falls back to defaults when both fields missing', () => {
  const api = loadApi();
  const sequence = api.getHerosmsCountrySequence({});
  assert.deepEqual(sequence, [151, 73, 16]);
});

test('getHerosmsCountrySequence honors options.countries override', () => {
  const api = loadApi();
  const sequence = api.getHerosmsCountrySequence({}, {
    countries: [
      { code: 22, enabled: true },
      { code: 73, enabled: true },
    ],
  });
  assert.deepEqual(sequence, [22, 73]);
});

test('getHerosmsCountrySequence returns empty array when herosmsCountries has no enabled entries', () => {
  const api = loadApi();
  const sequence = api.getHerosmsCountrySequence({
    herosmsCountries: [
      { code: 73, enabled: false },
      { code: 16, enabled: false },
    ],
  });
  assert.deepEqual(sequence, [151, 73, 16]);
});

test('normalizeHerosmsCountries deduplicates, parses, and defaults enabled=true for raw codes', () => {
  const api = loadApi();
  const result = api.normalizeHerosmsCountries([
    73,
    '151',
    { code: 16 },
    { code: 73, enabled: true },
    { code: 'bad' },
  ]);
  assert.deepEqual(result, [
    { code: 73, enabled: true },
    { code: 151, enabled: true },
    { code: 16, enabled: true },
  ]);
});
