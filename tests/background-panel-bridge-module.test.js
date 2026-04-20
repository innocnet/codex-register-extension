const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports panel bridge module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /importScripts\([\s\S]*'background\/panel-bridge\.js'/);
});

test('panel bridge module exposes a factory', () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundPanelBridge;`)(globalScope);

  assert.equal(typeof api?.createPanelBridge, 'function');
});

test('panel bridge requests oauth url with step 7 log label payload', () => {
  const source = fs.readFileSync('background/panel-bridge.js', 'utf8');
  assert.match(source, /logStep:\s*7/);
  assert.doesNotMatch(source, /logStep:\s*6/);
});
