const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'background/steps/open-chatgpt.js'), 'utf8');
const api = new Function('self', `${source}; return self.MultiPageBackgroundStep1;`)({});

function setupExecutor(overrides = {}) {
  const calls = [];
  const logs = [];
  const executor = api.createStep1Executor({
    addLog: async (message, level) => { logs.push({ message, level: level || 'info' }); },
    clearChatGptSessionCookies: overrides.clearChatGptSessionCookies
      || (async (options = {}) => {
        calls.push({ method: 'clearChatGptSessionCookies', options });
        return { removed: 2, supported: true };
      }),
    openSignupEntryTab: overrides.openSignupEntryTab
      || (async (step) => {
        calls.push({ method: 'openSignupEntryTab', step });
        return 99;
      }),
    completeStepFromBackground: overrides.completeStepFromBackground
      || (async (step, payload) => {
        calls.push({ method: 'completeStepFromBackground', step, payload });
      }),
  });
  return { executor, calls, logs };
}

test('executeStep1 clears chatgpt cookies before opening the signup entry tab', async () => {
  const { executor, calls, logs } = setupExecutor();
  await executor.executeStep1();
  const methods = calls.map((entry) => entry.method);
  const cookieIndex = methods.indexOf('clearChatGptSessionCookies');
  const openIndex = methods.indexOf('openSignupEntryTab');
  const completeIndex = methods.indexOf('completeStepFromBackground');

  assert.notEqual(cookieIndex, -1, 'cookie cleanup must be called');
  assert.notEqual(openIndex, -1, 'open signup entry must be called');
  assert.notEqual(completeIndex, -1, 'completeStepFromBackground must be called');
  assert.ok(cookieIndex < openIndex, 'cookie cleanup should run before opening the tab');
  assert.ok(openIndex < completeIndex, 'tab open should run before completion');
  assert.equal(calls.find((entry) => entry.method === 'openSignupEntryTab').step, 1);
  assert.ok(logs.some((entry) => entry.message.includes('清理可能存在的 ChatGPT 登录 cookies')));
  assert.ok(logs.some((entry) => entry.message.includes('已删除 2 个 ChatGPT / OpenAI cookies')));
});

test('executeStep1 still proceeds when cookies API is unsupported', async () => {
  let cookieCalls = 0;
  const { executor, calls, logs } = setupExecutor({
    clearChatGptSessionCookies: async () => {
      cookieCalls += 1;
      return { removed: 0, supported: false };
    },
  });
  await executor.executeStep1();
  assert.equal(cookieCalls, 1, 'cookie cleanup should still be invoked even when unsupported');
  assert.deepEqual(calls.map((entry) => entry.method), [
    'openSignupEntryTab',
    'completeStepFromBackground',
  ]);
  assert.equal(
    logs.filter((entry) => entry.message.includes('已删除')).length,
    0,
    'must not claim deletion when cookies API is unsupported'
  );
});

test('executeStep1 skips cleanup gracefully when helper is missing (backward compat)', async () => {
  const calls = [];
  const logs = [];
  const executor = api.createStep1Executor({
    addLog: async (message, level) => { logs.push({ message, level: level || 'info' }); },
    openSignupEntryTab: async (step) => { calls.push({ method: 'openSignupEntryTab', step }); return 99; },
    completeStepFromBackground: async (step, payload) => { calls.push({ method: 'completeStepFromBackground', step, payload }); },
  });
  await executor.executeStep1();
  assert.deepEqual(calls.map((entry) => entry.method), [
    'openSignupEntryTab',
    'completeStepFromBackground',
  ]);
  assert.equal(
    logs.filter((entry) => entry.message.includes('清理可能存在的 ChatGPT 登录 cookies')).length,
    0,
    'must not log cleanup message when helper missing'
  );
});
