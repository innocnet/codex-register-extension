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

test('skipStep cascades from step 1 to step 5 when downstream steps are pending', async () => {
  const bundle = [
    extractFunction('isStepDoneStatus'),
    extractFunction('skipStep'),
  ].join('\n');

  const statuses = {
    1: 'pending',
    2: 'pending',
    3: 'pending',
    4: 'pending',
    5: 'pending',
    6: 'pending',
    7: 'pending',
    8: 'pending',
    9: 'pending',
    10: 'pending',
  };

  const events = {
    setStepStatusCalls: [],
    logs: [],
  };

  const api = new Function(`
const STEP_IDS = [1,2,3,4,5,6,7,8,9,10];
${bundle}
return { skipStep };
`)();

  globalThis.ensureManualInteractionAllowed = async () => ({
    stepStatuses: { ...statuses },
  });
  globalThis.getState = async () => ({
    stepStatuses: { ...statuses },
  });
  globalThis.setStepStatus = async (step, status) => {
    events.setStepStatusCalls.push({ step, status });
    statuses[step] = status;
  };
  globalThis.addLog = async (message, level) => {
    events.logs.push({ message, level });
  };

  const result = await api.skipStep(1);

  assert.deepStrictEqual(result, { ok: true, step: 1, status: 'skipped' });
  assert.deepStrictEqual(events.setStepStatusCalls, [
    { step: 1, status: 'skipped' },
    { step: 2, status: 'skipped' },
    { step: 3, status: 'skipped' },
    { step: 4, status: 'skipped' },
    { step: 5, status: 'skipped' },
  ]);
  assert.equal(events.logs[0]?.message, '步骤 1 已跳过');
  assert.equal(events.logs[1]?.message, '步骤 1 已跳过，步骤 2、3、4、5 也已同时跳过。');
});

test('skipStep from step 1 skips only unfinished steps up to step 5', async () => {
  const bundle = [
    extractFunction('isStepDoneStatus'),
    extractFunction('skipStep'),
  ].join('\n');

  const statuses = {
    1: 'pending',
    2: 'completed',
    3: 'running',
    4: 'pending',
    5: 'manual_completed',
    6: 'pending',
    7: 'pending',
    8: 'pending',
    9: 'pending',
    10: 'pending',
  };

  const events = {
    setStepStatusCalls: [],
    logs: [],
  };

  const api = new Function(`
const STEP_IDS = [1,2,3,4,5,6,7,8,9,10];
${bundle}
return { skipStep };
`)();

  globalThis.ensureManualInteractionAllowed = async () => ({
    stepStatuses: { ...statuses },
  });
  globalThis.getState = async () => ({
    stepStatuses: { ...statuses },
  });
  globalThis.setStepStatus = async (step, status) => {
    events.setStepStatusCalls.push({ step, status });
    statuses[step] = status;
  };
  globalThis.addLog = async (message, level) => {
    events.logs.push({ message, level });
  };

  await api.skipStep(1);

  assert.deepStrictEqual(events.setStepStatusCalls, [
    { step: 1, status: 'skipped' },
    { step: 4, status: 'skipped' },
  ]);
  assert.equal(events.logs.some(({ message }) => message === '步骤 1 已跳过，步骤 4 也已同时跳过。'), true);
});
