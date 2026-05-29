# CPA 账号重新授权流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给扩展加一个「重新授权」功能：识别 CPA 里掉登录的异常账号，对其走邮箱登录（复用 step7~10）重新授权；遇手机二次验证则在 CPA 禁用账号并备注 `sms-failed`。

**Architecture:** 新增两个后台纯逻辑模块（`cpa-admin-client` 调 CPA admin 接口、`reauth-orchestrator` 编排单账号重授权），通过 message-router 暴露两个新 message type，侧边栏新增「重新授权」区块手动逐条触发。复用现有 `executeStep(7..10)` 与 `isAddPhoneAuthFailure`，不碰 auto-run 状态机。

**Tech Stack:** Chrome MV3 扩展、原生 JS（UMD 工厂模块模式）、`node:test` + `node:assert/strict` 单元测试（`npm test` → `node --test tests/*.test.js`）。

---

## 设计参考

详见 `docs/superpowers/specs/2026-05-29-cpa-reauth-flow-design.md`。

## 文件结构

- **Create** `background/cpa-admin-client.js` — CPA admin 接口客户端（纯逻辑工厂，注入 fetch）。职责：列表、探活、禁用+备注、汇总异常。
- **Create** `background/reauth-orchestrator.js` — 单账号重授权编排（纯逻辑工厂）。职责：注入运行上下文、顺序跑 step7~10、捕获手机验证失败做 sms-failed 处理。
- **Create** `tests/cpa-admin-client.test.js` — `cpa-admin-client` 单测。
- **Create** `tests/reauth-orchestrator.test.js` — `reauth-orchestrator` 单测。
- **Modify** `background.js` — `importScripts` 引入两模块；实例化并注入依赖；给 message-router deps 挂 `reauthFetchAbnormal` / `reauthRunAccount`。
- **Modify** `background/message-router.js` — 新增 `REAUTH_FETCH_ABNORMAL` / `REAUTH_RUN_ACCOUNT` 两个 case；deps 解构加两个函数。
- **Modify** `sidepanel/sidepanel.html` — 新增「重新授权（CPA）」区块 DOM。
- **Modify** `sidepanel/sidepanel.js` — 区块交互逻辑（拉取异常、手动加入、逐条重授权、状态徽章）。

## 关于「联调钉死」的接口常量

CPA admin 接口的确切路径/字段/鉴权头是未知项（设计文档第 9 节）。本计划把它们集中成 `cpa-admin-client.js` 顶部的常量 + 一个可注入的 `authHeader` 构造函数，**先按 new-api 风格写默认值**，单测用 fetch stub 不依赖真实接口。真实接口在功能联调阶段（执行完本计划后）用浏览器抓包校正这些常量即可，不阻塞编码与测试。

默认常量（可在联调时改）：
- 列表：`GET {origin}/api/v1/admin/accounts`，响应 `{ data: [{ id, email, ... }] }`
- 探活（刷新额度）：`POST {origin}/api/v1/admin/accounts/{id}/refresh`
- 禁用：`PUT {origin}/api/v1/admin/accounts/{id}`，body `{ status: 'disabled', remark: note }`
- 鉴权：`Authorization: Bearer {managementKey}`

---

## Task 1: CPA Admin 客户端骨架与鉴权头

**Files:**
- Create: `background/cpa-admin-client.js`
- Test: `tests/cpa-admin-client.test.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/cpa-admin-client.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCpaAdminClient,
  CpaAdminError,
  DEFAULTS,
} = require('../background/cpa-admin-client.js');

function makeFetchStub(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses[i] || responses[responses.length - 1];
    i += 1;
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };
  return { fetchImpl, calls };
}

test('factory derives origin from a CPA management url and builds auth header', () => {
  const { fetchImpl } = makeFetchStub([]);
  const client = createCpaAdminClient({
    fetchImpl,
    baseUrl: 'https://host.example/management.html#/oauth',
    managementKey: 'KEY123',
  });
  assert.equal(client.origin, 'https://host.example');
  assert.deepEqual(client.authHeader(), { Authorization: 'Bearer KEY123' });
});

test('factory throws when managementKey missing', () => {
  const { fetchImpl } = makeFetchStub([]);
  assert.throws(
    () => createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: '' }),
    /managementKey/
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/cpa-admin-client.test.js` （或 `node --test tests/cpa-admin-client.test.js`）
Expected: FAIL，报 `Cannot find module '../background/cpa-admin-client.js'`

- [ ] **Step 3: 写最小实现**

创建 `background/cpa-admin-client.js`：

```js
// background/cpa-admin-client.js
(function attachCpaAdminClient(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageCpaAdminClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createCpaAdminClientModule() {
  const DEFAULTS = Object.freeze({
    LIST_PATH: '/api/v1/admin/accounts',
    REFRESH_PATH: (id) => `/api/v1/admin/accounts/${id}/refresh`,
    DISABLE_PATH: (id) => `/api/v1/admin/accounts/${id}`,
    TIMEOUT_MS: 30000,
  });

  class CpaAdminError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'CpaAdminError';
      this.code = code || 'UNKNOWN';
    }
  }

  function deriveOrigin(rawUrl) {
    const url = new URL(String(rawUrl));
    return url.origin;
  }

  function createCpaAdminClient(options = {}) {
    const managementKey = String(options.managementKey || '').trim();
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULTS.TIMEOUT_MS;

    if (!managementKey) throw new CpaAdminError('managementKey is required', 'NO_KEY');
    if (!fetchImpl) throw new CpaAdminError('fetch implementation missing', 'NO_FETCH');

    const origin = deriveOrigin(options.baseUrl || '');

    function authHeader() {
      return { Authorization: `Bearer ${managementKey}` };
    }

    return { origin, authHeader };
  }

  return { createCpaAdminClient, CpaAdminError, DEFAULTS };
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add background/cpa-admin-client.js tests/cpa-admin-client.test.js
git commit -m "feat(cpa-admin): 客户端骨架与鉴权头构造（TDD）"
```

---

## Task 2: listAccounts

**Files:**
- Modify: `background/cpa-admin-client.js`
- Test: `tests/cpa-admin-client.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/cpa-admin-client.test.js` 末尾追加：

```js
test('listAccounts GETs list path with auth header and returns data array', async () => {
  const { fetchImpl, calls } = makeFetchStub([
    { status: 200, body: { data: [{ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@y.com' }] } },
  ]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const accounts = await client.listAccounts();
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[0], { id: 1, email: 'a@x.com' });
  assert.equal(calls[0].url, 'https://h.x/api/v1/admin/accounts');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer K');
});

test('listAccounts throws CpaAdminError on non-2xx', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 500, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  await assert.rejects(() => client.listAccounts(), /HTTP 500/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: FAIL，报 `client.listAccounts is not a function`

- [ ] **Step 3: 写最小实现**

在 `cpa-admin-client.js` 的 `createCpaAdminClient` 内、`return` 之前加一个通用请求助手和 `listAccounts`，并把它加入返回对象：

```js
    async function requestJson(path, { method = 'GET', body } = {}) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(`${origin}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        });
        return response;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function listAccounts() {
      const response = await requestJson(DEFAULTS.LIST_PATH);
      if (!response.ok) {
        throw new CpaAdminError(`listAccounts HTTP ${response.status}`, `HTTP_${response.status}`);
      }
      const payload = await response.json();
      const items = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.list) ? payload.list
        : Array.isArray(payload) ? payload
        : [];
      return items;
    }
```

把返回对象改为：

```js
    return { origin, authHeader, listAccounts };
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add background/cpa-admin-client.js tests/cpa-admin-client.test.js
git commit -m "feat(cpa-admin): listAccounts 解析 data/list/数组三种响应"
```

---

## Task 3: probeAccount（401 探活）

**Files:**
- Modify: `background/cpa-admin-client.js`
- Test: `tests/cpa-admin-client.test.js`

- [ ] **Step 1: 写失败测试**

追加：

```js
test('probeAccount returns abnormal=true on 401', async () => {
  const { fetchImpl, calls } = makeFetchStub([{ status: 401, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const result = await client.probeAccount(7);
  assert.deepEqual(result, { abnormal: true });
  assert.equal(calls[0].url, 'https://h.x/api/v1/admin/accounts/7/refresh');
  assert.equal(calls[0].opts.method, 'POST');
});

test('probeAccount returns abnormal=false on 2xx', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 200, body: { ok: true } }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  assert.deepEqual(await client.probeAccount(7), { abnormal: false });
});

test('probeAccount returns {error} on unexpected status', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 503, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const result = await client.probeAccount(7);
  assert.equal(result.abnormal, false);
  assert.match(result.error, /503/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: FAIL，报 `client.probeAccount is not a function`

- [ ] **Step 3: 写最小实现**

在 `listAccounts` 之后加 `probeAccount`：

```js
    async function probeAccount(id) {
      const response = await requestJson(DEFAULTS.REFRESH_PATH(id), { method: 'POST' });
      if (response.status === 401) return { abnormal: true };
      if (response.ok) return { abnormal: false };
      return { abnormal: false, error: `probeAccount HTTP ${response.status}` };
    }
```

返回对象加入 `probeAccount`：

```js
    return { origin, authHeader, listAccounts, probeAccount };
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: PASS（7 tests）

- [ ] **Step 5: 提交**

```bash
git add background/cpa-admin-client.js tests/cpa-admin-client.test.js
git commit -m "feat(cpa-admin): probeAccount 以刷新额度 401 判定异常"
```

---

## Task 4: disableAccount（禁用 + 备注）

**Files:**
- Modify: `background/cpa-admin-client.js`
- Test: `tests/cpa-admin-client.test.js`

- [ ] **Step 1: 写失败测试**

追加：

```js
test('disableAccount PUTs status disabled with remark note', async () => {
  const { fetchImpl, calls } = makeFetchStub([{ status: 200, body: { ok: true } }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  await client.disableAccount(9, 'sms-failed');
  assert.equal(calls[0].url, 'https://h.x/api/v1/admin/accounts/9');
  assert.equal(calls[0].opts.method, 'PUT');
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.equal(sentBody.status, 'disabled');
  assert.equal(sentBody.remark, 'sms-failed');
});

test('disableAccount throws on non-2xx', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 403, body: {} }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  await assert.rejects(() => client.disableAccount(9, 'sms-failed'), /HTTP 403/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: FAIL，报 `client.disableAccount is not a function`

- [ ] **Step 3: 写最小实现**

在 `probeAccount` 之后加 `disableAccount`：

```js
    async function disableAccount(id, note) {
      const response = await requestJson(DEFAULTS.DISABLE_PATH(id), {
        method: 'PUT',
        body: { status: 'disabled', remark: String(note || '') },
      });
      if (!response.ok) {
        throw new CpaAdminError(`disableAccount HTTP ${response.status}`, `HTTP_${response.status}`);
      }
      return { disabled: true };
    }
```

返回对象加入 `disableAccount`：

```js
    return { origin, authHeader, listAccounts, probeAccount, disableAccount };
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add background/cpa-admin-client.js tests/cpa-admin-client.test.js
git commit -m "feat(cpa-admin): disableAccount 禁用并写 sms-failed 备注"
```

---

## Task 5: listAbnormalAccounts（汇总）

**Files:**
- Modify: `background/cpa-admin-client.js`
- Test: `tests/cpa-admin-client.test.js`

- [ ] **Step 1: 写失败测试**

追加：

```js
test('listAbnormalAccounts returns only accounts whose probe is abnormal', async () => {
  // 第1次 listAccounts；之后每个账号一次 probe
  const { fetchImpl } = makeFetchStub([
    { status: 200, body: { data: [{ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@y.com' }] } },
    { status: 401, body: {} }, // id 1 异常
    { status: 200, body: {} }, // id 2 正常
  ]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  const abnormal = await client.listAbnormalAccounts();
  assert.equal(abnormal.length, 1);
  assert.deepEqual(abnormal[0], { id: 1, email: 'a@x.com' });
});

test('listAbnormalAccounts on empty list returns empty array', async () => {
  const { fetchImpl } = makeFetchStub([{ status: 200, body: { data: [] } }]);
  const client = createCpaAdminClient({ fetchImpl, baseUrl: 'https://h.x/', managementKey: 'K' });
  assert.deepEqual(await client.listAbnormalAccounts(), []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: FAIL，报 `client.listAbnormalAccounts is not a function`

- [ ] **Step 3: 写最小实现**

在 `disableAccount` 之后加 `listAbnormalAccounts`（串行 probe，避免打爆 CPA）：

```js
    async function listAbnormalAccounts() {
      const accounts = await listAccounts();
      const abnormal = [];
      for (const account of accounts) {
        const id = account?.id;
        if (id === undefined || id === null) continue;
        const result = await probeAccount(id);
        if (result.abnormal) abnormal.push(account);
      }
      return abnormal;
    }
```

返回对象加入 `listAbnormalAccounts`：

```js
    return { origin, authHeader, listAccounts, probeAccount, disableAccount, listAbnormalAccounts };
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/cpa-admin-client.test.js`
Expected: PASS（11 tests）

- [ ] **Step 5: 提交**

```bash
git add background/cpa-admin-client.js tests/cpa-admin-client.test.js
git commit -m "feat(cpa-admin): listAbnormalAccounts 串行探活汇总异常账号"
```

---

## Task 6: 重授权编排器 — 成功路径

**Files:**
- Create: `background/reauth-orchestrator.js`
- Test: `tests/reauth-orchestrator.test.js`

- [ ] **Step 1: 写失败测试**

创建 `tests/reauth-orchestrator.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createReauthOrchestrator } = require('../background/reauth-orchestrator.js');

function makeDeps(overrides = {}) {
  const state = { current: {} };
  const calls = { steps: [], logs: [], disabled: [], appended: [] };
  return {
    getState: async () => ({ ...state.current }),
    setState: async (patch) => { Object.assign(state.current, patch); },
    addLog: async (msg, level) => { calls.logs.push({ msg, level }); },
    executeStep: async (step) => { calls.steps.push(step); },
    isAddPhoneAuthFailure: () => false,
    getFixedPassword: () => 'fixedpw',
    appendAccountRunRecord: async (status, st, reason) => { calls.appended.push({ status, reason }); },
    cpaAdminClient: {
      listAccounts: async () => [],
      disableAccount: async (id, note) => { calls.disabled.push({ id, note }); },
    },
    _state: state,
    _calls: calls,
    ...overrides,
  };
}

test('runForAccount injects email/password/cpa context and clears signupPhone', async () => {
  const deps = makeDeps();
  const orch = createReauthOrchestrator(deps);
  await orch.runForAccount({ email: 'a@x.com', accountId: 1 });
  assert.equal(deps._state.current.email, 'a@x.com');
  assert.equal(deps._state.current.password, 'fixedpw');
  assert.equal(deps._state.current.panelMode, 'cpa');
  assert.equal(deps._state.current.signupPhone, null);
  assert.equal(deps._state.current.signupPhoneCountry, null);
});

test('runForAccount runs steps 7,8,9,10 in order and returns success', async () => {
  const deps = makeDeps();
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: 1 });
  assert.deepEqual(deps._calls.steps, [7, 8, 9, 10]);
  assert.equal(result.status, 'success');
  assert.equal(result.email, 'a@x.com');
  assert.equal(deps._calls.appended.length, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/reauth-orchestrator.test.js`
Expected: FAIL，报 `Cannot find module '../background/reauth-orchestrator.js'`

- [ ] **Step 3: 写最小实现**

创建 `background/reauth-orchestrator.js`：

```js
// background/reauth-orchestrator.js
(function attachReauthOrchestrator(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageReauthOrchestrator = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createReauthOrchestratorModule() {
  const REAUTH_STEPS = [7, 8, 9, 10];

  function createReauthOrchestrator(deps = {}) {
    const {
      getState,
      setState,
      addLog,
      executeStep,
      isAddPhoneAuthFailure,
      getFixedPassword,
      appendAccountRunRecord,
      cpaAdminClient,
    } = deps;

    async function runForAccount({ email, accountId } = {}) {
      const password = String((getFixedPassword && getFixedPassword()) || '').trim();
      await setState({
        email,
        password,
        panelMode: 'cpa',
        signupPhone: null,
        signupPhoneCountry: null,
      });

      try {
        for (const step of REAUTH_STEPS) {
          await executeStep(step);
        }
        await addLog(`重新授权成功：${email}`, 'ok');
        if (typeof appendAccountRunRecord === 'function') {
          await appendAccountRunRecord('success', await getState(), 'reauth');
        }
        return { status: 'success', email };
      } catch (err) {
        return await handleFailure(err, { email, accountId });
      }
    }

    async function handleFailure(err, { email, accountId }) {
      // 占位：下一任务填充手机验证失败处理
      const message = err && err.message ? err.message : String(err);
      await addLog(`重新授权失败：${email}（${message}）`, 'error');
      return { status: 'failed', email, error: message };
    }

    return { runForAccount };
  }

  return { createReauthOrchestrator, REAUTH_STEPS };
});
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/reauth-orchestrator.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add background/reauth-orchestrator.js tests/reauth-orchestrator.test.js
git commit -m "feat(reauth): 编排器成功路径，注入 CPA 上下文跑 step7~10"
```

---

## Task 7: 编排器 — 手机二次验证失败处理

**Files:**
- Modify: `background/reauth-orchestrator.js`
- Test: `tests/reauth-orchestrator.test.js`

- [ ] **Step 1: 写失败测试**

追加：

```js
test('runForAccount disables account with sms-failed note on phone-2FA failure', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => true,
    executeStep: async (step) => { if (step === 7) throw new Error('add-phone required'); },
  });
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: 42 });
  assert.equal(result.status, 'sms-failed');
  assert.deepEqual(deps._calls.disabled, [{ id: 42, note: 'sms-failed' }]);
});

test('phone-2FA failure without accountId looks up id by email before disabling', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => true,
    executeStep: async () => { throw new Error('add-phone'); },
  });
  deps.cpaAdminClient.listAccounts = async () => [{ id: 99, email: 'a@x.com' }];
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: null });
  assert.equal(result.status, 'sms-failed');
  assert.deepEqual(deps._calls.disabled, [{ id: 99, note: 'sms-failed' }]);
});

test('phone-2FA failure with no resolvable id logs and skips disable', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => true,
    executeStep: async () => { throw new Error('add-phone'); },
  });
  deps.cpaAdminClient.listAccounts = async () => [];
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: null });
  assert.equal(result.status, 'sms-failed');
  assert.equal(deps._calls.disabled.length, 0);
});

test('non-phone failure returns failed without disabling or recording', async () => {
  const deps = makeDeps({
    isAddPhoneAuthFailure: () => false,
    executeStep: async () => { throw new Error('network blip'); },
  });
  const orch = createReauthOrchestrator(deps);
  const result = await orch.runForAccount({ email: 'a@x.com', accountId: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(deps._calls.disabled.length, 0);
  assert.equal(deps._calls.appended.length, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/reauth-orchestrator.test.js`
Expected: FAIL（手机验证用例期望 `sms-failed` 与 disable，但当前 `handleFailure` 一律返回 `failed`）

- [ ] **Step 3: 写最小实现**

替换 `handleFailure` 整个函数为：

```js
    async function handleFailure(err, { email, accountId }) {
      const message = err && err.message ? err.message : String(err);

      if (isAddPhoneAuthFailure && isAddPhoneAuthFailure(err)) {
        let id = accountId;
        if ((id === undefined || id === null) && cpaAdminClient && typeof cpaAdminClient.listAccounts === 'function') {
          try {
            const accounts = await cpaAdminClient.listAccounts();
            const match = accounts.find((a) => String(a?.email || '').toLowerCase() === String(email || '').toLowerCase());
            if (match) id = match.id;
          } catch (lookupErr) {
            await addLog(`重新授权：反查账号 ID 失败（${lookupErr.message}）`, 'warn');
          }
        }

        if (id !== undefined && id !== null && cpaAdminClient && typeof cpaAdminClient.disableAccount === 'function') {
          try {
            await cpaAdminClient.disableAccount(id, 'sms-failed');
            await addLog(`账号触发手机二次验证，已在 CPA 禁用并备注 sms-failed：${email}`, 'warn');
          } catch (disableErr) {
            await addLog(`重新授权：禁用账号失败（${disableErr.message}）`, 'error');
          }
        } else {
          await addLog(`账号触发手机二次验证，但未找到可禁用的账号 ID：${email}`, 'warn');
        }
        return { status: 'sms-failed', email };
      }

      await addLog(`重新授权失败：${email}（${message}）`, 'error');
      return { status: 'failed', email, error: message };
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/reauth-orchestrator.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add background/reauth-orchestrator.js tests/reauth-orchestrator.test.js
git commit -m "feat(reauth): 手机二次验证失败则禁用账号并备注 sms-failed"
```

---

## Task 8: message-router 新增两个 case

**Files:**
- Modify: `background/message-router.js`
- Test: `tests/reauth-message-router.test.js` (Create)

- [ ] **Step 1: 写失败测试**

创建 `tests/reauth-message-router.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageRouter } = require('../background/message-router.js');

function makeRouter(overrides = {}) {
  const calls = { fetchAbnormal: 0, runArgs: null };
  const deps = {
    reauthFetchAbnormal: async () => { calls.fetchAbnormal += 1; return [{ id: 1, email: 'a@x.com' }]; },
    reauthRunAccount: async (payload) => { calls.runArgs = payload; return { status: 'success', email: payload.email }; },
  };
  return { router: createMessageRouter({ ...deps, ...overrides }), calls };
}

test('REAUTH_FETCH_ABNORMAL returns accounts list', async () => {
  const { router, calls } = makeRouter();
  const res = await router.handleMessage({ type: 'REAUTH_FETCH_ABNORMAL', source: 'sidepanel' });
  assert.equal(calls.fetchAbnormal, 1);
  assert.equal(res.ok, true);
  assert.equal(res.accounts.length, 1);
});

test('REAUTH_RUN_ACCOUNT forwards email and accountId', async () => {
  const { router, calls } = makeRouter();
  const res = await router.handleMessage({
    type: 'REAUTH_RUN_ACCOUNT',
    source: 'sidepanel',
    payload: { email: 'a@x.com', accountId: 7 },
  });
  assert.deepEqual(calls.runArgs, { email: 'a@x.com', accountId: 7 });
  assert.equal(res.ok, true);
  assert.equal(res.result.status, 'success');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/reauth-message-router.test.js`
Expected: FAIL（返回 `{ error: 'Unknown message type: REAUTH_FETCH_ABNORMAL' }`，断言 `res.ok` 不成立）

- [ ] **Step 3: 写最小实现**

在 `background/message-router.js` 的 deps 解构（约第 96 行 `verifyHotmailAccount,` 之后、`} = deps;` 之前）加：

```js
      reauthFetchAbnormal,
      reauthRunAccount,
```

在 `case 'ACCOUNTS_REEXPORT':` 之后、`case 'STOP_FLOW':` 之前插入：

```js
        case 'REAUTH_FETCH_ABNORMAL': {
          if (typeof reauthFetchAbnormal !== 'function') {
            throw new Error('重新授权功能未就绪：缺少 reauthFetchAbnormal。');
          }
          const accounts = await reauthFetchAbnormal();
          return { ok: true, accounts: Array.isArray(accounts) ? accounts : [] };
        }

        case 'REAUTH_RUN_ACCOUNT': {
          if (typeof reauthRunAccount !== 'function') {
            throw new Error('重新授权功能未就绪：缺少 reauthRunAccount。');
          }
          const email = String(message.payload?.email || '').trim();
          if (!email) {
            throw new Error('重新授权需要邮箱。');
          }
          const accountIdRaw = message.payload?.accountId;
          const accountId = accountIdRaw === undefined ? null : accountIdRaw;
          const result = await reauthRunAccount({ email, accountId });
          return { ok: true, result };
        }
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/reauth-message-router.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add background/message-router.js tests/reauth-message-router.test.js
git commit -m "feat(router): REAUTH_FETCH_ABNORMAL / REAUTH_RUN_ACCOUNT 两个消息"
```

---

## Task 9: background.js 装配

**Files:**
- Modify: `background.js`

> 本任务是接线，无独立单测；用全量测试套件作为回归验证。

- [ ] **Step 1: 引入脚本**

在 `background.js` 顶部 `importScripts(...)` 列表里，`'background/accounts-exporter.js'` 附近（保持与现有 background 模块同段）加入两行：

```js
  'background/cpa-admin-client.js',
  'background/reauth-orchestrator.js',
```

（确认它们与 `'background/message-router.js'` 在同一个 importScripts 调用中，且排在 message-router 之前。）

- [ ] **Step 2: 实例化两个模块**

在 `const messageRouter = self.MultiPageBackgroundMessageRouter?.createMessageRouter({`（约第 6669 行）**之前**，插入：

```js
function getCpaAdminClient() {
  // 每次按当前 state 重新构造，避免 vpsUrl / vpsPassword 改动后用旧值
  return null; // 占位，下一步替换
}
```

随后把这个占位实现替换为真实版本：

```js
async function getCpaAdminClient() {
  const state = await getState();
  const baseUrl = String(state.vpsUrl || '').trim();
  const managementKey = String(state.vpsPassword || '').trim();
  if (!baseUrl) throw new Error('尚未配置 CPA 地址，请先在侧边栏填写。');
  if (!managementKey) throw new Error('尚未配置 CPA 管理密钥，请先在侧边栏填写。');
  return self.MultiPageCpaAdminClient.createCpaAdminClient({
    baseUrl,
    managementKey,
    fetchImpl: (...args) => fetch(...args),
  });
}

async function reauthFetchAbnormal() {
  const client = await getCpaAdminClient();
  return client.listAbnormalAccounts();
}

async function reauthRunAccount({ email, accountId }) {
  const client = await getCpaAdminClient();
  const orchestrator = self.MultiPageReauthOrchestrator.createReauthOrchestrator({
    getState,
    setState,
    addLog,
    executeStep,
    isAddPhoneAuthFailure,
    getFixedPassword: () => String((/* current */ '')),
    appendAccountRunRecord,
    cpaAdminClient: client,
  });
  // getFixedPassword 需读当前 customPassword：用闭包内 await 取，见下
  return orchestrator.runForAccount({ email, accountId });
}
```

- [ ] **Step 3: 修正固定密码取值**

把 `reauthRunAccount` 改为先取一次 state，再传同步 `getFixedPassword`：

```js
async function reauthRunAccount({ email, accountId }) {
  const client = await getCpaAdminClient();
  const state = await getState();
  const fixedPassword = String(state.customPassword || '').trim();
  const orchestrator = self.MultiPageReauthOrchestrator.createReauthOrchestrator({
    getState,
    setState,
    addLog,
    executeStep,
    isAddPhoneAuthFailure,
    getFixedPassword: () => fixedPassword,
    appendAccountRunRecord,
    cpaAdminClient: client,
  });
  return orchestrator.runForAccount({ email, accountId });
}
```

- [ ] **Step 4: 把两个函数注入 message-router deps**

在 `createMessageRouter({ ... })` 的依赖对象里（与其它 deps 并列）加：

```js
  reauthFetchAbnormal,
  reauthRunAccount,
```

- [ ] **Step 5: 运行全量测试回归**

Run: `npm test`
Expected: 全绿（含新增的 cpa-admin-client / reauth-orchestrator / reauth-message-router 测试）。

> 注意：`appendAccountRunRecord`、`isAddPhoneAuthFailure`、`executeStep`、`getState`、`setState`、`addLog` 均为 background.js 内已存在的标识符（见现有 message-router deps 注入处）。若某个不在装配作用域内，使用其在 deps 对象中对应的已有引用名。

- [ ] **Step 6: 提交**

```bash
git add background.js
git commit -m "feat(reauth): background 装配 cpa-admin-client 与 reauth 编排器"
```

---

## Task 10: 侧边栏「重新授权」区块 DOM

**Files:**
- Modify: `sidepanel/sidepanel.html`

> 纯 DOM 任务，靠 Task 11 的逻辑与手动验证覆盖。

- [ ] **Step 1: 找到插入点**

在 `sidepanel/sidepanel.html` 里找到账号记录相关区块（`account-records` 或 herosms 余额区附近的某个 `<section>`/`<div class="...">` 容器）。在一个合适的设置区块之后插入下面的区块。

- [ ] **Step 2: 插入区块 DOM**

```html
<section class="reauth-section" id="reauth-section">
  <h3 class="section-title">重新授权（CPA）</h3>
  <div class="reauth-actions">
    <button id="btn-reauth-fetch-abnormal" class="btn">拉取异常账号</button>
    <span id="reauth-fetch-status" class="reauth-status"></span>
  </div>
  <div class="reauth-manual">
    <label for="reauth-manual-input">手动指定（每行一个邮箱）：</label>
    <textarea id="reauth-manual-input" rows="3" placeholder="a@x.com&#10;b@y.com"></textarea>
    <button id="btn-reauth-add-manual" class="btn">加入列表</button>
  </div>
  <ul id="reauth-list" class="reauth-list"></ul>
</section>
```

- [ ] **Step 3: 加最小样式**

在 `sidepanel/sidepanel.css` 末尾加：

```css
.reauth-section { margin-top: 12px; }
.reauth-list { list-style: none; padding: 0; margin: 8px 0 0; }
.reauth-list-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.reauth-list-item .reauth-email { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.reauth-badge { font-size: 12px; padding: 1px 6px; border-radius: 4px; }
.reauth-badge.pending { color: #888; }
.reauth-badge.running { color: #1565c0; }
.reauth-badge.success { color: #2e7d32; }
.reauth-badge.failed { color: #c62828; }
.reauth-badge.sms-failed { color: #b8860b; }
```

- [ ] **Step 4: 手动确认渲染**

加载扩展，打开侧边栏，确认「重新授权（CPA）」区块、按钮与文本框可见（功能尚未接线，下个任务接）。

- [ ] **Step 5: 提交**

```bash
git add sidepanel/sidepanel.html sidepanel/sidepanel.css
git commit -m "feat(sidepanel): 新增重新授权（CPA）区块 DOM 与样式"
```

---

## Task 11: 侧边栏「重新授权」交互逻辑

**Files:**
- Modify: `sidepanel/sidepanel.js`

> 交互逻辑，靠手动验证覆盖（与现有侧边栏代码风格一致）。

- [ ] **Step 1: 获取 DOM 引用**

在 `sidepanel.js` 顶部 DOM 引用区（与 `btnAccountsReexport` 等并列）加：

```js
const btnReauthFetchAbnormal = document.getElementById('btn-reauth-fetch-abnormal');
const reauthFetchStatus = document.getElementById('reauth-fetch-status');
const reauthManualInput = document.getElementById('reauth-manual-input');
const btnReauthAddManual = document.getElementById('btn-reauth-add-manual');
const reauthListEl = document.getElementById('reauth-list');
```

- [ ] **Step 2: 维护列表状态与渲染**

在合适位置（靠近其它渲染函数）加：

```js
const reauthRows = new Map(); // email -> { email, accountId, status }

function renderReauthList() {
  if (!reauthListEl) return;
  reauthListEl.innerHTML = '';
  for (const row of reauthRows.values()) {
    const li = document.createElement('li');
    li.className = 'reauth-list-item';

    const emailSpan = document.createElement('span');
    emailSpan.className = 'reauth-email';
    emailSpan.textContent = row.email;
    emailSpan.title = row.email;

    const runBtn = document.createElement('button');
    runBtn.className = 'btn';
    runBtn.textContent = '重授权';
    runBtn.disabled = row.status === 'running';
    runBtn.addEventListener('click', () => runReauthForEmail(row.email));

    const badge = document.createElement('span');
    const statusText = {
      pending: '待处理', running: '运行中', success: '成功',
      failed: '失败', 'sms-failed': 'sms-failed',
    }[row.status] || row.status;
    badge.className = `reauth-badge ${row.status}`;
    badge.textContent = statusText;

    li.append(emailSpan, runBtn, badge);
    reauthListEl.appendChild(li);
  }
}

function upsertReauthRow(email, patch) {
  const key = email.toLowerCase();
  const prev = reauthRows.get(key) || { email, accountId: null, status: 'pending' };
  reauthRows.set(key, { ...prev, ...patch, email: prev.email });
  renderReauthList();
}
```

- [ ] **Step 3: 拉取异常账号**

```js
async function fetchAbnormalAccounts() {
  if (reauthFetchStatus) reauthFetchStatus.textContent = '正在拉取...';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'REAUTH_FETCH_ABNORMAL', source: 'sidepanel',
    });
    if (!response?.ok) throw new Error(response?.error || '拉取失败');
    for (const acc of response.accounts) {
      if (!acc?.email) continue;
      upsertReauthRow(acc.email, { accountId: acc.id ?? null, status: 'pending' });
    }
    if (reauthFetchStatus) reauthFetchStatus.textContent = `共 ${response.accounts.length} 个异常账号`;
  } catch (err) {
    if (reauthFetchStatus) reauthFetchStatus.textContent = `拉取失败：${err.message}`;
  }
}

btnReauthFetchAbnormal?.addEventListener('click', fetchAbnormalAccounts);
```

- [ ] **Step 4: 手动加入**

```js
function addManualReauthEmails() {
  const raw = (reauthManualInput?.value || '').split(/\r?\n/);
  let added = 0;
  for (const line of raw) {
    const email = line.trim();
    if (!email) continue;
    upsertReauthRow(email, { accountId: null });
    added += 1;
  }
  if (reauthManualInput) reauthManualInput.value = '';
  if (reauthFetchStatus && added) reauthFetchStatus.textContent = `已加入 ${added} 个邮箱`;
}

btnReauthAddManual?.addEventListener('click', addManualReauthEmails);
```

- [ ] **Step 5: 逐条重授权**

```js
async function runReauthForEmail(email) {
  const key = email.toLowerCase();
  const row = reauthRows.get(key);
  if (!row) return;
  upsertReauthRow(email, { status: 'running' });
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'REAUTH_RUN_ACCOUNT', source: 'sidepanel',
      payload: { email: row.email, accountId: row.accountId },
    });
    if (!response?.ok) throw new Error(response?.error || '执行失败');
    upsertReauthRow(email, { status: response.result?.status || 'failed' });
  } catch (err) {
    upsertReauthRow(email, { status: 'failed' });
  }
}
```

- [ ] **Step 6: 手动验证整链**

加载扩展 → 填好 CPA 地址/管理密钥与固定密码 → 点「拉取异常账号」看是否填充列表 → 手动加一个邮箱 → 点某行「重授权」，观察日志区步骤 7~10 执行与该行徽章变化。

- [ ] **Step 7: 提交**

```bash
git add sidepanel/sidepanel.js
git commit -m "feat(sidepanel): 重新授权区块交互（拉取/手动加入/逐条重授权）"
```

---

## Task 12: 全量回归与 CPA 接口联调校正

**Files:**
- Modify: `background/cpa-admin-client.js`（仅在联调发现默认接口常量不符时）

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 2: 联调校正接口常量**

用浏览器打开真实 CPA 后台账号页，F12 → Network 抓取：列表、刷新额度、禁用+备注三个请求。对照 `cpa-admin-client.js` 顶部 `DEFAULTS` 与 `authHeader()`：
- 若路径/方法不符 → 改 `DEFAULTS.LIST_PATH` / `REFRESH_PATH` / `DISABLE_PATH`。
- 若鉴权头不符（非 `Authorization: Bearer`）→ 改 `authHeader()`。
- 若禁用 body 字段名不符（非 `status`/`remark`）→ 改 `disableAccount` 的 body 与对应测试断言。
- 若列表字段名不符（非 `id`/`email`）→ 在 `listAccounts` 做字段映射归一，并更新测试。

每改一处，先更新对应单测再改实现，保持 TDD。

- [ ] **Step 3: 真实环境冒烟**

对一个已知掉登录的真实账号走完整重授权，确认成功路径有效；对一个会触发手机验证的账号，确认被禁用且 CPA 备注为 `sms-failed`。

- [ ] **Step 4: 提交（若有改动）**

```bash
git add background/cpa-admin-client.js tests/cpa-admin-client.test.js
git commit -m "fix(cpa-admin): 按真实 CPA 接口校正路径/字段/鉴权"
```

---

## 自检结论

- **Spec 覆盖**：自动拉取异常（Task 5+9+11）、手动指定（Task 11 Step 4）、复用 step7~10（Task 6）、固定密码（Task 9 Step 3）、清空 signupPhone 走邮箱登录（Task 6）、手机验证→禁用+sms-failed（Task 7）、手动逐条触发（Task 11 Step 5）、成功写历史/其他失败仅日志（Task 6/7）、message type（Task 8）、装配（Task 9）、UI（Task 10/11）、联调钉死接口（Task 12）——均有对应任务。
- **类型一致**：客户端方法 `listAccounts`/`probeAccount`/`disableAccount`/`listAbnormalAccounts`/`authHeader`/`origin` 在各任务保持一致；编排器 `runForAccount({email, accountId})` 返回 `{status, email, error?}`，status 取值 `success`/`failed`/`sms-failed` 全程统一；message type `REAUTH_FETCH_ABNORMAL`/`REAUTH_RUN_ACCOUNT` 一致。
- **无占位**：每个代码步骤含完整代码与命令。Task 9 Step 2 的占位 `getCpaAdminClient` 在同任务 Step 2/3 内被真实实现替换，属刻意的渐进式接线，非遗留占位。
