const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports verification flow module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/verification-flow\.js/);
});

test('verification flow module exposes a factory', () => {
  const source = fs.readFileSync('background/verification-flow.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundVerificationFlow;`)(globalScope);

  assert.equal(typeof api?.createVerificationFlowHelpers, 'function');
});
