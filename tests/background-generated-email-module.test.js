const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports generated email helper module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /importScripts\([\s\S]*'background\/generated-email-helpers\.js'/);
});

test('generated email helper module exposes a factory', () => {
  const source = fs.readFileSync('background/generated-email-helpers.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageGeneratedEmailHelpers;`)(globalScope);

  assert.equal(typeof api?.createGeneratedEmailHelpers, 'function');
});
