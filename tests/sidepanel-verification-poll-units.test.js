const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

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

test('sidepanel stores verification poll interval inputs in seconds as milliseconds', () => {
  const bundle = [
    extractFunction('normalizeVerificationPollIntervalMs'),
    extractFunction('normalizeVerificationPollIntervalMsFromSeconds'),
    extractFunction('formatVerificationPollIntervalSecondsInputValue'),
  ].join('\n');

  const api = new Function(`
const VERIFICATION_POLL_INTERVAL_MIN_MS = 1000;
const VERIFICATION_POLL_INTERVAL_MAX_MS = 60000;
${bundle}
return {
  normalizeVerificationPollIntervalMsFromSeconds,
  formatVerificationPollIntervalSecondsInputValue,
};
`)();

  assert.equal(api.normalizeVerificationPollIntervalMsFromSeconds('9', null), 9000);
  assert.equal(api.normalizeVerificationPollIntervalMsFromSeconds('0', null), 1000);
  assert.equal(api.normalizeVerificationPollIntervalMsFromSeconds('61', null), 60000);
  assert.equal(api.formatVerificationPollIntervalSecondsInputValue(9000), '9');
  assert.equal(api.formatVerificationPollIntervalSecondsInputValue(11000), '11');
  assert.equal(api.formatVerificationPollIntervalSecondsInputValue(20000), '20');
  assert.equal(api.formatVerificationPollIntervalSecondsInputValue(null), '');
});
