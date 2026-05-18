# Codex 注册机增强实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 codex-oauth-automation-extension（Chrome MV3 扩展）的注册流程上集成 HeroSMS 短信验证、Cloudflare Turnstile 反检测补丁、accounts.txt 自动落盘，并启用现有 iCloud 自动选号。

**Architecture:** content/signup-page.js 检测 `add_phone_page` 时不再 throw，转为通过 `chrome.runtime.sendMessage` 触发 background；background 新增 HeroSMS HTTP 客户端 + 短信验证状态机；注册成功后写 `accounts.txt`；MAIN-world content script 修补 `MouseEvent.screenX/screenY` 以规避 CDP 点击检测。

**Tech Stack:**
- Chrome MV3 service worker，纯 JS（无构建步骤）
- `node:test` + `node:assert/strict`（运行 `npm test`）
- HeroSMS API（sms-activate 兼容协议，基础 URL `https://hero-sms.com/stubs/handler_api.php`）
- `chrome.downloads`、`chrome.storage.local`、`chrome.runtime.sendMessage`

**关联设计稿：** `docs/superpowers/specs/2026-05-18-codex-register-enhance-design.md`

---

## 项目结构与文件清单

| 文件 | 类型 | 责任 |
|---|---|---|
| `background/herosms-client.js` | 新增 | HeroSMS HTTP 客户端（getNumber/getStatus/setStatus），不持状态 |
| `background/phone-verify-flow.js` | 新增 | 短信验证状态机：换号/重发上限/国家偏好 fallback |
| `background/accounts-exporter.js` | 新增 | 追加 accounts.txt（chrome.storage + chrome.downloads） |
| `content/patches/mouse-event-patch.js` | 新增 | MAIN world，document_start，修 MouseEvent.screenX/screenY |
| `tests/herosms-client.test.js` | 新增 | 客户端单元测试 |
| `tests/phone-verify-flow.test.js` | 新增 | 状态机单元测试 |
| `tests/accounts-exporter.test.js` | 新增 | 导出器单元测试 |
| `manifest.json` | 修改 | 加 `downloads` 权限；注册 mouse-event-patch、phone-verify content script 入口 |
| `background.js` | 修改 | 加载新模块、注入到 message-router、注册成功后调 accountsExporter |
| `background/message-router.js` | 修改 | 新增 `PHONE_VERIFY_*` case |
| `content/signup-page.js` | 修改 | `add_phone_page` 检测后不再 throw，触发 SMS 流程 |
| `sidepanel/sidepanel.html` | 修改 | 加 HeroSMS 配置 UI |
| `sidepanel/sidepanel.js` | 修改 | 读写 herosms 配置、emailGenerator 默认值 |

---

## Phase 0：准备

### Task 0.1：在 manifest 加 `downloads` 权限

**Files:**
- Modify: `manifest.json:7-19`

- [ ] **Step 1: 读取当前 manifest 权限段**

```bash
sed -n '7,19p' manifest.json
```

应该看到 7-19 行的 `"permissions": [...]` 数组（包含 sidePanel、alarms、tabs、webNavigation、declarativeNetRequest、debugger、browsingData、cookies、storage、scripting、activeTab）。

- [ ] **Step 2: 加 downloads 权限**

把 `manifest.json` 的 `"permissions"` 数组里最后一项 `"activeTab"` 改为：

```json
    "activeTab",
    "downloads"
```

- [ ] **Step 3: 重新加载扩展验证无报错**

打开 `chrome://extensions`，找到「多页面自动化」，点重新加载按钮。Service worker 日志不应有 manifest 解析错误。

- [ ] **Step 4: Commit**

```bash
git add manifest.json
git commit -m "feat(manifest): 启用 downloads 权限以支持 accounts.txt 落盘"
```

---

## Phase 1：HeroSMS HTTP 客户端（TDD）

### Task 1.1：写客户端骨架与第一个失败测试（URL/参数构造）

**Files:**
- Create: `background/herosms-client.js`
- Create: `tests/herosms-client.test.js`

- [ ] **Step 1: 创建客户端文件骨架**

```js
// background/herosms-client.js
(function attachHerosmsClient(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageHerosmsClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHerosmsClientModule() {
  const DEFAULT_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const DEFAULT_TIMEOUT_MS = 30000;

  class HerosmsError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'HerosmsError';
      this.code = code || 'UNKNOWN';
    }
  }
  class NoNumbersError extends HerosmsError { constructor(msg='NO_NUMBERS'){ super(msg,'NO_NUMBERS'); this.name='NoNumbersError'; } }
  class NoBalanceError extends HerosmsError { constructor(msg='NO_BALANCE'){ super(msg,'NO_BALANCE'); this.name='NoBalanceError'; } }
  class AuthenticationError extends HerosmsError { constructor(msg='BAD_KEY'){ super(msg,'BAD_KEY'); this.name='AuthenticationError'; } }
  class BannedError extends HerosmsError {
    constructor(msg, until) {
      super(msg || 'BANNED', 'BANNED');
      this.name = 'BannedError';
      this.until = until || 0;
    }
  }

  function buildUrl(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function createHerosmsClient(options = {}) {
    const apiKey = String(options.apiKey || '').trim();
    const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    if (!apiKey) throw new HerosmsError('apiKey is required', 'BAD_KEY');
    if (!fetchImpl) throw new HerosmsError('fetch implementation missing', 'NO_FETCH');

    function urlFor(action, extra = {}) {
      return buildUrl(baseUrl, { api_key: apiKey, action, ...extra });
    }

    return { urlFor };
  }

  return {
    createHerosmsClient,
    HerosmsError,
    NoNumbersError,
    NoBalanceError,
    AuthenticationError,
    BannedError,
    DEFAULT_BASE_URL,
  };
});
```

- [ ] **Step 2: 写 URL 构造的失败测试**

```js
// tests/herosms-client.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHerosmsClient,
  HerosmsError,
  NoNumbersError,
  NoBalanceError,
  AuthenticationError,
  BannedError,
  DEFAULT_BASE_URL,
} = require('../background/herosms-client.js');

function makeFetchStub(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses[i] || responses[responses.length - 1];
    i += 1;
    if (next instanceof Error) throw next;
    return {
      ok: true,
      text: async () => String(next),
    };
  };
  return { fetchImpl, calls };
}

test('urlFor builds query string with api_key, action and extras', () => {
  const { fetchImpl } = makeFetchStub([]);
  const client = createHerosmsClient({ apiKey: 'KEY123', fetchImpl });
  const url = client.urlFor('getNumber', { service: 'oi', country: 151 });
  assert.match(url, /^https:\/\/hero-sms\.com\/stubs\/handler_api\.php\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('api_key'), 'KEY123');
  assert.equal(parsed.searchParams.get('action'), 'getNumber');
  assert.equal(parsed.searchParams.get('service'), 'oi');
  assert.equal(parsed.searchParams.get('country'), '151');
});
```

- [ ] **Step 3: 跑测试，确认通过（骨架已实现）**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: PASS（1 test passed）

- [ ] **Step 4: Commit**

```bash
git add background/herosms-client.js tests/herosms-client.test.js
git commit -m "feat(herosms): 客户端骨架与 URL 构造（TDD）"
```

### Task 1.2：实现 `getNumber` 并解析成功响应

**Files:**
- Modify: `background/herosms-client.js`
- Modify: `tests/herosms-client.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/herosms-client.test.js` 末尾追加：

```js
test('getNumber returns {id, phone} on ACCESS_NUMBER response', async () => {
  const { fetchImpl, calls } = makeFetchStub(['ACCESS_NUMBER:9876:56912345678']);
  const client = createHerosmsClient({ apiKey: 'KEY', fetchImpl });
  const result = await client.getNumber({ service: 'oi', country: 151 });
  assert.deepEqual(result, { id: '9876', phone: '56912345678' });
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('action'), 'getNumber');
  assert.equal(parsed.searchParams.get('service'), 'oi');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: FAIL（`client.getNumber is not a function`）

- [ ] **Step 3: 实现 getNumber**

在 `background/herosms-client.js` 的 `createHerosmsClient` 返回对象前，加：

```js
    async function callApi(action, extra = {}) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(urlFor(action, extra), controller ? { signal: controller.signal } : undefined);
        const text = (await response.text()).trim();
        return text;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function getNumber({ service, country, maxPrice, operator } = {}) {
      const text = await callApi('getNumber', { service, country, maxPrice, operator });
      if (text.startsWith('ACCESS_NUMBER:')) {
        const [, id, phone] = text.split(':');
        return { id: String(id), phone: String(phone) };
      }
      throw parseError(text);
    }

    function parseError(text) {
      if (!text) return new HerosmsError('empty response', 'EMPTY');
      if (text === 'NO_NUMBERS') return new NoNumbersError();
      if (text === 'NO_BALANCE') return new NoBalanceError();
      if (text === 'BAD_KEY') return new AuthenticationError();
      if (text.startsWith('BANNED:')) {
        const until = parseInt(text.split(':')[1] || '0', 10);
        return new BannedError(text, Number.isFinite(until) ? until : 0);
      }
      return new HerosmsError(text, text.toUpperCase());
    }
```

把返回对象改成：

```js
    return { urlFor, getNumber };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/herosms-client.js tests/herosms-client.test.js
git commit -m "feat(herosms): 实现 getNumber 与响应解析"
```

### Task 1.3：getNumber 错误码解析（NO_NUMBERS / NO_BALANCE / BAD_KEY / BANNED）

**Files:**
- Modify: `tests/herosms-client.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/herosms-client.test.js` 末尾追加：

```js
test('getNumber throws NoNumbersError on NO_NUMBERS', async () => {
  const { fetchImpl } = makeFetchStub(['NO_NUMBERS']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'NO_NUMBERS');
    assert.equal(err.name, 'NoNumbersError');
    return true;
  });
});

test('getNumber throws AuthenticationError on BAD_KEY', async () => {
  const { fetchImpl } = makeFetchStub(['BAD_KEY']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'BAD_KEY');
    return true;
  });
});

test('getNumber throws NoBalanceError on NO_BALANCE', async () => {
  const { fetchImpl } = makeFetchStub(['NO_BALANCE']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'NO_BALANCE');
    return true;
  });
});

test('getNumber throws BannedError with until timestamp', async () => {
  const { fetchImpl } = makeFetchStub(['BANNED:1735689600']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.getNumber({ service: 'oi', country: 151 }), (err) => {
    assert.equal(err.code, 'BANNED');
    assert.equal(err.until, 1735689600);
    return true;
  });
});
```

- [ ] **Step 2: 跑测试确认全部通过（实现已具备）**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: PASS（共 6 个测试）

- [ ] **Step 3: Commit**

```bash
git add tests/herosms-client.test.js
git commit -m "test(herosms): 覆盖 getNumber 错误码"
```

### Task 1.4：实现 `getStatus`

**Files:**
- Modify: `background/herosms-client.js`
- Modify: `tests/herosms-client.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/herosms-client.test.js` 末尾追加：

```js
test('getStatus returns {status:"ok", code} on STATUS_OK', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_OK:485712']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'ok', code: '485712' });
});

test('getStatus returns {status:"wait"} on STATUS_WAIT_CODE', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_WAIT_CODE']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'wait' });
});

test('getStatus returns {status:"wait_retry"} with lastCode on STATUS_WAIT_RETRY', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_WAIT_RETRY:000111']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'wait_retry', lastCode: '000111' });
});

test('getStatus returns {status:"cancel"} on STATUS_CANCEL', async () => {
  const { fetchImpl } = makeFetchStub(['STATUS_CANCEL']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  const result = await client.getStatus('123');
  assert.deepEqual(result, { status: 'cancel' });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: FAIL（`client.getStatus is not a function`）

- [ ] **Step 3: 实现 getStatus**

在 `background/herosms-client.js` 的 `getNumber` 函数下方追加：

```js
    async function getStatus(id) {
      const text = await callApi('getStatus', { id });
      if (text === 'STATUS_WAIT_CODE') return { status: 'wait' };
      if (text === 'STATUS_CANCEL') return { status: 'cancel' };
      if (text.startsWith('STATUS_OK:')) {
        return { status: 'ok', code: text.slice('STATUS_OK:'.length) };
      }
      if (text.startsWith('STATUS_WAIT_RETRY:')) {
        return { status: 'wait_retry', lastCode: text.slice('STATUS_WAIT_RETRY:'.length) };
      }
      throw parseError(text);
    }
```

把返回对象改成：

```js
    return { urlFor, getNumber, getStatus };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/herosms-client.js tests/herosms-client.test.js
git commit -m "feat(herosms): 实现 getStatus"
```

### Task 1.5：实现 `setStatus`

**Files:**
- Modify: `background/herosms-client.js`
- Modify: `tests/herosms-client.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/herosms-client.test.js` 末尾追加：

```js
test('setStatus sends action=setStatus with status and id', async () => {
  const { fetchImpl, calls } = makeFetchStub(['ACCESS_READY']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await client.setStatus('9999', 3);
  const parsed = new URL(calls[0]);
  assert.equal(parsed.searchParams.get('action'), 'setStatus');
  assert.equal(parsed.searchParams.get('id'), '9999');
  assert.equal(parsed.searchParams.get('status'), '3');
});

test('setStatus rejects on unknown response', async () => {
  const { fetchImpl } = makeFetchStub(['NO_ACTIVATION']);
  const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
  await assert.rejects(() => client.setStatus('1', 6));
});

test('setStatus accepts ACCESS_READY / ACCESS_RETRY_GET / ACCESS_ACTIVATION / ACCESS_CANCEL', async () => {
  const replies = ['ACCESS_READY', 'ACCESS_RETRY_GET', 'ACCESS_ACTIVATION', 'ACCESS_CANCEL'];
  for (const reply of replies) {
    const { fetchImpl } = makeFetchStub([reply]);
    const client = createHerosmsClient({ apiKey: 'K', fetchImpl });
    await client.setStatus('1', 1);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: FAIL

- [ ] **Step 3: 实现 setStatus**

在 `background/herosms-client.js` 的 `getStatus` 函数下方追加：

```js
    const SET_STATUS_OK = new Set(['ACCESS_READY', 'ACCESS_RETRY_GET', 'ACCESS_ACTIVATION', 'ACCESS_CANCEL']);

    async function setStatus(id, status) {
      const text = await callApi('setStatus', { id, status });
      if (SET_STATUS_OK.has(text)) return;
      throw parseError(text);
    }
```

把返回对象改成：

```js
    return { urlFor, getNumber, getStatus, setStatus };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/herosms-client.js tests/herosms-client.test.js
git commit -m "feat(herosms): 实现 setStatus"
```

### Task 1.6：导出常量（COUNTRY_CODES、SERVICE_OPENAI、STATUS_CODES）

**Files:**
- Modify: `background/herosms-client.js`
- Modify: `tests/herosms-client.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/herosms-client.test.js` 顶部 require 行扩展为：

```js
const {
  createHerosmsClient,
  HerosmsError,
  NoNumbersError,
  NoBalanceError,
  AuthenticationError,
  BannedError,
  DEFAULT_BASE_URL,
  COUNTRY_CODES,
  SERVICE_OPENAI,
  STATUS_CODES,
} = require('../background/herosms-client.js');
```

在文件末尾追加：

```js
test('exports country / service / status constants used by phone-verify-flow', () => {
  assert.equal(COUNTRY_CODES.CHILE, 151);
  assert.equal(COUNTRY_CODES.BRAZIL, 73);
  assert.equal(COUNTRY_CODES.UK, 16);
  assert.equal(SERVICE_OPENAI, 'oi');
  assert.equal(STATUS_CODES.SMS_SENT, 1);
  assert.equal(STATUS_CODES.REQUEST_RESEND, 3);
  assert.equal(STATUS_CODES.COMPLETE, 6);
  assert.equal(STATUS_CODES.CANCEL, 8);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: FAIL（`COUNTRY_CODES is undefined`）

- [ ] **Step 3: 实现常量并导出**

在 `background/herosms-client.js` 的 `DEFAULT_BASE_URL` 下方加：

```js
  const COUNTRY_CODES = Object.freeze({ CHILE: 151, BRAZIL: 73, UK: 16 });
  const SERVICE_OPENAI = 'oi';
  const STATUS_CODES = Object.freeze({ SMS_SENT: 1, REQUEST_RESEND: 3, COMPLETE: 6, CANCEL: 8 });
```

并把模块 return 改为：

```js
  return {
    createHerosmsClient,
    HerosmsError,
    NoNumbersError,
    NoBalanceError,
    AuthenticationError,
    BannedError,
    DEFAULT_BASE_URL,
    COUNTRY_CODES,
    SERVICE_OPENAI,
    STATUS_CODES,
  };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/herosms-client.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/herosms-client.js tests/herosms-client.test.js
git commit -m "feat(herosms): 导出 country/service/status 常量"
```

---

## Phase 2：accounts-exporter（TDD）

### Task 2.1：写第一个失败测试 + 骨架

**Files:**
- Create: `background/accounts-exporter.js`
- Create: `tests/accounts-exporter.test.js`

- [ ] **Step 1: 创建骨架文件**

```js
// background/accounts-exporter.js
(function attachAccountsExporter(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageAccountsExporter = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createAccountsExporterModule() {
  const STORAGE_KEY = 'codexAccountsExport';
  const FILENAME = 'accounts.txt';

  function encodeContent(records) {
    const lines = records.map(r => `${r.email}----${r.password}`).join('\n');
    return lines.length ? lines + '\n' : '';
  }

  function toDataUrl(content) {
    const base64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(content)))
      : Buffer.from(content, 'utf-8').toString('base64');
    return `data:text/plain;charset=utf-8;base64,${base64}`;
  }

  function createAccountsExporter(deps = {}) {
    const storage = deps.chromeStorage;
    const downloads = deps.chromeDownloads;
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new Error('accounts-exporter requires chromeStorage with get/set');
    }
    if (!downloads || typeof downloads.download !== 'function') {
      throw new Error('accounts-exporter requires chromeDownloads with download()');
    }

    async function listAccounts() {
      const result = await storage.get(STORAGE_KEY);
      const value = result && result[STORAGE_KEY];
      return Array.isArray(value) ? value : [];
    }

    async function appendAccount({ email, password }) {
      if (!email || !password) throw new Error('email and password are required');
      const prev = await listAccounts();
      const next = [...prev, { email, password, savedAt: Date.now() }];
      await storage.set({ [STORAGE_KEY]: next });
      const url = toDataUrl(encodeContent(next));
      await downloads.download({
        url,
        filename: FILENAME,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      return { saved: next.length };
    }

    async function reexportAll() {
      const records = await listAccounts();
      const url = toDataUrl(encodeContent(records));
      await downloads.download({
        url,
        filename: FILENAME,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      return { saved: records.length };
    }

    return { appendAccount, reexportAll, listAccounts };
  }

  return { createAccountsExporter, STORAGE_KEY, FILENAME };
});
```

- [ ] **Step 2: 写第一个测试**

```js
// tests/accounts-exporter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountsExporter, STORAGE_KEY } = require('../background/accounts-exporter.js');

function makeMocks(initialStorage = {}) {
  const storage = { ...initialStorage };
  const downloadCalls = [];
  return {
    chromeStorage: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (patch) => Object.assign(storage, patch),
    },
    chromeDownloads: {
      download: async (opts) => { downloadCalls.push(opts); return 1; },
    },
    storage,
    downloadCalls,
  };
}

test('appendAccount stores record and triggers download with overwrite', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await exporter.appendAccount({ email: 'a@b.com', password: 'pw' });

  assert.equal(m.storage[STORAGE_KEY].length, 1);
  assert.equal(m.storage[STORAGE_KEY][0].email, 'a@b.com');
  assert.equal(m.downloadCalls.length, 1);
  assert.equal(m.downloadCalls[0].filename, 'accounts.txt');
  assert.equal(m.downloadCalls[0].conflictAction, 'overwrite');
  assert.match(m.downloadCalls[0].url, /^data:text\/plain;charset=utf-8;base64,/);
});
```

- [ ] **Step 3: 跑测试确认通过（骨架已实现）**

```bash
npm test -- tests/accounts-exporter.test.js
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add background/accounts-exporter.js tests/accounts-exporter.test.js
git commit -m "feat(accounts-exporter): 骨架与单条 append 测试"
```

### Task 2.2：累积写入语义 + reexportAll 测试

**Files:**
- Modify: `tests/accounts-exporter.test.js`

- [ ] **Step 1: 追加失败测试**

```js
test('appendAccount appends to existing list cumulatively', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await exporter.appendAccount({ email: 'a@b.com', password: 'p1' });
  await exporter.appendAccount({ email: 'c@d.com', password: 'p2' });

  assert.equal(m.storage[STORAGE_KEY].length, 2);

  const lastUrl = m.downloadCalls[1].url;
  const base64 = lastUrl.replace(/^data:text\/plain;charset=utf-8;base64,/, '');
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  assert.equal(decoded, 'a@b.com----p1\nc@d.com----p2\n');
});

test('reexportAll writes complete file based on storage', async () => {
  const m = makeMocks({
    [STORAGE_KEY]: [
      { email: 'x@y.com', password: 'a' },
      { email: 'y@z.com', password: 'b' },
    ],
  });
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await exporter.reexportAll();

  const base64 = m.downloadCalls[0].url.replace(/^data:text\/plain;charset=utf-8;base64,/, '');
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  assert.equal(decoded, 'x@y.com----a\ny@z.com----b\n');
});

test('listAccounts returns [] when storage is empty', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  assert.deepEqual(await exporter.listAccounts(), []);
});

test('appendAccount rejects missing fields', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await assert.rejects(() => exporter.appendAccount({ email: '', password: 'p' }));
  await assert.rejects(() => exporter.appendAccount({ email: 'a@b.com', password: '' }));
});
```

- [ ] **Step 2: 跑测试确认通过**

```bash
npm test -- tests/accounts-exporter.test.js
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/accounts-exporter.test.js
git commit -m "test(accounts-exporter): 累积写入与 reexportAll"
```

---

## Phase 3：过机器检查补丁

### Task 3.1：新增 MouseEvent 补丁脚本

**Files:**
- Create: `content/patches/mouse-event-patch.js`

- [ ] **Step 1: 确认目录存在**

```bash
mkdir -p content/patches
```

- [ ] **Step 2: 创建补丁文件**

```js
// content/patches/mouse-event-patch.js
// Cloudflare Turnstile 反检测：修复 Chromium 在 CDP Input.dispatchMouseEvent 下
// MouseEvent.screenX/screenY 与 x/y 相同的 bug。
// 参考：grok-register/script/turnstilePatch/script.js
(function patchMouseEventScreenCoords() {
  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  const screenX = getRandomInt(800, 1200);
  const screenY = getRandomInt(400, 600);
  try {
    Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
    Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
  } catch (_) {
    // 已被定义过，忽略
  }
})();
```

- [ ] **Step 3: Commit**

```bash
git add content/patches/mouse-event-patch.js
git commit -m "feat(content): MouseEvent.screenX/screenY 反检测补丁"
```

### Task 3.2：在 manifest 注册 MAIN-world 注入

**Files:**
- Modify: `manifest.json:40-106`

- [ ] **Step 1: 阅读现有 content_scripts 段**

```bash
sed -n '40,106p' manifest.json
```

会看到 5 个 content script 入口（auth.openai.com、qq.mail、163、icloud.com、duckduckgo）。

- [ ] **Step 2: 在 `content_scripts` 数组里追加一项（紧贴第一个 auth0.openai.com 入口后面，在第二个 qq.mail 入口前）**

定位 `manifest.json` 中 `"matches": ["https://auth0.openai.com/*", ...]` 这一对象（开头大约在第 41 行）。在 **它的结束 `}` 之后，下一个 `{ matches: ["https://mail.qq.com/*"...` 之前**插入：

```json
    {
      "matches": [
        "https://auth0.openai.com/*",
        "https://auth.openai.com/*",
        "https://accounts.openai.com/*"
      ],
      "js": ["content/patches/mouse-event-patch.js"],
      "world": "MAIN",
      "run_at": "document_start",
      "all_frames": true
    },
```

- [ ] **Step 3: 重新加载扩展确认无解析错误**

`chrome://extensions` → 重新加载，service worker 控制台不应有 manifest error。

- [ ] **Step 4: 在 auth.openai.com 任一页面打开 DevTools 控制台，确认补丁生效**

```js
new MouseEvent('click').screenX
```

Expected: 返回 800–1200 之间的整数（而非 0）。

- [ ] **Step 5: Commit**

```bash
git add manifest.json
git commit -m "feat(manifest): 注入 MouseEvent 反检测补丁到 auth*.openai.com"
```

---

## Phase 4：phone-verify-flow 状态机（TDD）

### Task 4.1：建模骨架 + REQUEST_NUMBER 成功路径

**Files:**
- Create: `background/phone-verify-flow.js`
- Create: `tests/phone-verify-flow.test.js`

- [ ] **Step 1: 创建骨架**

```js
// background/phone-verify-flow.js
(function attachPhoneVerifyFlow(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPagePhoneVerifyFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createPhoneVerifyFlowModule() {
  const DEFAULT_POLL_INTERVAL_MS = 5000;
  const DEFAULT_POLL_TIMEOUT_MS = 120000;
  const MAX_RESEND_CLICKS = 2;
  const MAX_ACTIVATIONS = 2;

  function createPhoneVerifyFlow(deps = {}) {
    const {
      herosmsClient,                                  // { getNumber, getStatus, setStatus }
      getCountryPreference = () => [151, 73, 16],     // sms-activate 国家 ID
      service = 'oi',
      addLog = async () => {},
      sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
      onNewNumber = async () => {},                   // 换号时通知 content
      now = () => Date.now(),
    } = deps;

    if (!herosmsClient) throw new Error('phone-verify-flow requires herosmsClient');

    const states = new Map(); // tabId → state

    function initState() {
      return {
        activationId: null,
        phone: null,
        countryIndex: 0,
        resendCount: 0,
        activationCount: 0,
        codePromise: null,
        codeResolve: null,
        codeReject: null,
        pollAbort: false,
      };
    }

    function getState(tabId) {
      let s = states.get(tabId);
      if (!s) { s = initState(); states.set(tabId, s); }
      return s;
    }

    async function tryGetNumber(state) {
      const preference = getCountryPreference();
      for (; state.countryIndex < preference.length; state.countryIndex++) {
        const country = preference[state.countryIndex];
        try {
          const { id, phone } = await herosmsClient.getNumber({ service, country });
          state.activationId = id;
          state.phone = phone;
          state.activationCount += 1;
          state.resendCount = 0;
          await addLog(`手机验证：取到号码 ${phone}（国家 ${country}，激活 ID ${id}）`, 'ok');
          return { phone, country };
        } catch (err) {
          if (err && err.code === 'NO_NUMBERS') {
            await addLog(`手机验证：国家 ${country} 暂无号码，尝试下一国家...`, 'warn');
            continue;
          }
          throw err;
        }
      }
      const e = new Error('所有偏好国家均无可用号码');
      e.code = 'NO_NUMBERS_ALL';
      throw e;
    }

    async function requestNumber(tabId) {
      const state = getState(tabId);
      if (state.activationCount >= MAX_ACTIVATIONS) {
        const e = new Error('已用尽可换号配额');
        e.code = 'ACTIVATION_EXHAUSTED';
        throw e;
      }
      return tryGetNumber(state);
    }

    function _internalReset(tabId) {
      states.delete(tabId);
    }

    return {
      requestNumber,
      _internalGetState: (tabId) => getState(tabId),
      _internalReset,
      MAX_RESEND_CLICKS,
      MAX_ACTIVATIONS,
    };
  }

  return { createPhoneVerifyFlow, MAX_RESEND_CLICKS, MAX_ACTIVATIONS };
});
```

- [ ] **Step 2: 写测试**

```js
// tests/phone-verify-flow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPhoneVerifyFlow, MAX_RESEND_CLICKS, MAX_ACTIVATIONS } = require('../background/phone-verify-flow.js');

function makeHerosmsStub({ getNumberReplies = [], getStatusReplies = [], setStatusReplies = [] } = {}) {
  const calls = { getNumber: [], getStatus: [], setStatus: [] };
  let gnI = 0, gsI = 0, ssI = 0;
  return {
    client: {
      async getNumber(opts) {
        calls.getNumber.push(opts);
        const next = getNumberReplies[gnI] || getNumberReplies[getNumberReplies.length - 1];
        gnI += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      async getStatus(id) {
        calls.getStatus.push(id);
        const next = getStatusReplies[gsI] || getStatusReplies[getStatusReplies.length - 1];
        gsI += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      async setStatus(id, status) {
        calls.setStatus.push({ id, status });
        const next = setStatusReplies[ssI];
        ssI += 1;
        if (next instanceof Error) throw next;
      },
    },
    calls,
  };
}

function noopSleep() { return Promise.resolve(); }

test('requestNumber returns first country phone on success', async () => {
  const sms = makeHerosmsStub({ getNumberReplies: [{ id: '111', phone: '+56912' }] });
  const flow = createPhoneVerifyFlow({ herosmsClient: sms.client, sleep: noopSleep });
  const r = await flow.requestNumber('tab-1');
  assert.equal(r.phone, '+56912');
  assert.equal(r.country, 151);
  assert.equal(sms.calls.getNumber.length, 1);
  assert.deepEqual(sms.calls.getNumber[0], { service: 'oi', country: 151 });
});

test('requestNumber falls back to next country on NO_NUMBERS', async () => {
  const noNumbers = Object.assign(new Error('NO_NUMBERS'), { code: 'NO_NUMBERS' });
  const sms = makeHerosmsStub({ getNumberReplies: [noNumbers, { id: '222', phone: '+5511' }] });
  const flow = createPhoneVerifyFlow({ herosmsClient: sms.client, sleep: noopSleep });
  const r = await flow.requestNumber('tab-1');
  assert.equal(r.country, 73);
  assert.equal(sms.calls.getNumber.length, 2);
});

test('requestNumber throws NO_NUMBERS_ALL when every country is NO_NUMBERS', async () => {
  const noNumbers = Object.assign(new Error('NO_NUMBERS'), { code: 'NO_NUMBERS' });
  const sms = makeHerosmsStub({ getNumberReplies: [noNumbers, noNumbers, noNumbers] });
  const flow = createPhoneVerifyFlow({ herosmsClient: sms.client, sleep: noopSleep });
  await assert.rejects(() => flow.requestNumber('tab-1'), (err) => {
    assert.equal(err.code, 'NO_NUMBERS_ALL');
    return true;
  });
  assert.equal(sms.calls.getNumber.length, 3);
});
```

- [ ] **Step 3: 跑测试确认通过**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: PASS（3 tests）

- [ ] **Step 4: Commit**

```bash
git add background/phone-verify-flow.js tests/phone-verify-flow.test.js
git commit -m "feat(phone-verify): requestNumber 与国家偏好 fallback"
```

### Task 4.2：requestCode 轮询成功路径

**Files:**
- Modify: `background/phone-verify-flow.js`
- Modify: `tests/phone-verify-flow.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/phone-verify-flow.test.js` 末尾追加：

```js
test('requestCode resolves with code when getStatus returns ok', async () => {
  const sms = makeHerosmsStub({
    getNumberReplies: [{ id: '111', phone: '+56912' }],
    getStatusReplies: [{ status: 'wait' }, { status: 'ok', code: '485712' }],
    setStatusReplies: [undefined],
  });
  const flow = createPhoneVerifyFlow({
    herosmsClient: sms.client,
    sleep: noopSleep,
    pollIntervalMs: 1,
    pollTimeoutMs: 100000,
  });
  await flow.requestNumber('tab-1');
  const { code } = await flow.requestCode('tab-1');
  assert.equal(code, '485712');
  assert.deepEqual(sms.calls.setStatus[0], { id: '111', status: 6 });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: FAIL（`flow.requestCode is not a function`）

- [ ] **Step 3: 实现 requestCode（最小成功路径）**

在 `background/phone-verify-flow.js` 的 `requestNumber` 函数下方追加：

```js
    async function pollUntilOk(state) {
      const deadline = now() + pollTimeoutMs;
      while (now() < deadline) {
        if (state.pollAbort) {
          const e = new Error('polling aborted'); e.code = 'ABORTED'; throw e;
        }
        const result = await herosmsClient.getStatus(state.activationId);
        if (result.status === 'ok') return result.code;
        if (result.status === 'cancel') {
          const e = new Error('activation cancelled by upstream'); e.code = 'UPSTREAM_CANCEL'; throw e;
        }
        await sleep(pollIntervalMs);
      }
      const e = new Error('polling timeout'); e.code = 'POLL_TIMEOUT'; throw e;
    }

    async function completeActivation(state) {
      try { await herosmsClient.setStatus(state.activationId, 6); } catch (_) {}
    }

    async function requestCode(tabId) {
      const state = getState(tabId);
      if (!state.activationId) {
        const e = new Error('no active number; call requestNumber first'); e.code = 'NO_ACTIVE_NUMBER'; throw e;
      }
      const code = await pollUntilOk(state);
      await completeActivation(state);
      return { code };
    }
```

并把模块 return 加上 `requestCode`：

```js
    return {
      requestNumber,
      requestCode,
      _internalGetState: (tabId) => getState(tabId),
      _internalReset,
      MAX_RESEND_CLICKS,
      MAX_ACTIVATIONS,
    };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/phone-verify-flow.js tests/phone-verify-flow.test.js
git commit -m "feat(phone-verify): requestCode 轮询并 COMPLETE 激活"
```

### Task 4.3：换号路径（POLL_TIMEOUT → SWITCH_NUMBER）

**Files:**
- Modify: `background/phone-verify-flow.js`
- Modify: `tests/phone-verify-flow.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/phone-verify-flow.test.js` 末尾追加：

```js
test('polling timeout triggers number switch and onNewNumber notification', async () => {
  let currentTime = 0;
  const sms = makeHerosmsStub({
    getNumberReplies: [
      { id: '111', phone: '+56912' },
      { id: '222', phone: '+5511' },
    ],
    // 第一个号一直 wait（超时），第二个号 ok
    getStatusReplies: [{ status: 'wait' }, { status: 'wait' }, { status: 'ok', code: 'CODE2' }],
    setStatusReplies: [undefined, undefined], // 一次 CANCEL，一次 COMPLETE
  });

  const newNumbers = [];
  const flow = createPhoneVerifyFlow({
    herosmsClient: sms.client,
    sleep: noopSleep,
    pollIntervalMs: 10,
    pollTimeoutMs: 25,                  // 让两次 getStatus 后必然超时
    now: () => { currentTime += 10; return currentTime; },
    onNewNumber: async (info) => { newNumbers.push(info); },
  });

  await flow.requestNumber('tab-1');
  const { code } = await flow.requestCode('tab-1');

  assert.equal(code, 'CODE2');
  assert.equal(sms.calls.getNumber.length, 2);
  assert.deepEqual(sms.calls.setStatus[0], { id: '111', status: 8 });   // CANCEL 第一个
  assert.deepEqual(sms.calls.setStatus[1], { id: '222', status: 6 });   // COMPLETE 第二个
  assert.equal(newNumbers.length, 1);
  assert.equal(newNumbers[0].phone, '+5511');
});

test('exceeding MAX_ACTIVATIONS during switch yields ACTIVATION_EXHAUSTED', async () => {
  let currentTime = 0;
  const sms = makeHerosmsStub({
    getNumberReplies: [
      { id: '111', phone: '+56912' },
      { id: '222', phone: '+5511' },
    ],
    getStatusReplies: [{ status: 'wait' }],   // 永远 wait → 一直超时
    setStatusReplies: [undefined, undefined],
  });
  const flow = createPhoneVerifyFlow({
    herosmsClient: sms.client,
    sleep: noopSleep,
    pollIntervalMs: 10,
    pollTimeoutMs: 15,
    now: () => { currentTime += 10; return currentTime; },
  });

  await flow.requestNumber('tab-1');
  await assert.rejects(() => flow.requestCode('tab-1'), (err) => {
    assert.equal(err.code, 'ACTIVATION_EXHAUSTED');
    return true;
  });
  assert.equal(sms.calls.getNumber.length, MAX_ACTIVATIONS);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: FAIL（换号未实现）

- [ ] **Step 3: 改写 requestCode 加入 SWITCH_NUMBER 循环**

把 `background/phone-verify-flow.js` 里的 `requestCode` 与 `pollUntilOk` 替换为：

```js
    async function cancelActivation(state) {
      if (!state.activationId) return;
      try { await herosmsClient.setStatus(state.activationId, 8); } catch (_) {}
      state.activationId = null;
      state.phone = null;
    }

    async function pollOnce(state, deadline) {
      while (now() < deadline) {
        if (state.pollAbort) {
          const e = new Error('polling aborted'); e.code = 'ABORTED'; throw e;
        }
        const result = await herosmsClient.getStatus(state.activationId);
        if (result.status === 'ok') return { kind: 'ok', code: result.code };
        if (result.status === 'cancel') return { kind: 'switch', reason: 'upstream_cancel' };
        await sleep(pollIntervalMs);
      }
      return { kind: 'switch', reason: 'timeout' };
    }

    async function requestCode(tabId) {
      const state = getState(tabId);
      if (!state.activationId) {
        const e = new Error('no active number; call requestNumber first'); e.code = 'NO_ACTIVE_NUMBER'; throw e;
      }
      // 主循环：允许换号
      while (true) {
        const deadline = now() + pollTimeoutMs;
        const r = await pollOnce(state, deadline);
        if (r.kind === 'ok') {
          await completeActivation(state);
          return { code: r.code };
        }
        // 换号
        await addLog(`手机验证：第 ${state.activationCount} 个号未拿到验证码（${r.reason}），尝试换号...`, 'warn');
        await cancelActivation(state);
        if (state.activationCount >= MAX_ACTIVATIONS) {
          const e = new Error('已用尽可换号配额'); e.code = 'ACTIVATION_EXHAUSTED'; throw e;
        }
        const next = await tryGetNumber(state);
        await onNewNumber({ phone: next.phone, country: next.country });
      }
    }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: PASS（共 5 tests）

- [ ] **Step 5: Commit**

```bash
git add background/phone-verify-flow.js tests/phone-verify-flow.test.js
git commit -m "feat(phone-verify): 轮询超时触发换号"
```

### Task 4.4：重发上限（USER_RESEND_CLICK → MAX_RESEND_CLICKS）

**Files:**
- Modify: `background/phone-verify-flow.js`
- Modify: `tests/phone-verify-flow.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/phone-verify-flow.test.js` 末尾追加：

```js
test('notifyResendClicked allows up to MAX_RESEND_CLICKS times', async () => {
  const sms = makeHerosmsStub({
    getNumberReplies: [{ id: '111', phone: '+56912' }],
    setStatusReplies: [undefined, undefined],
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: sms.client, sleep: noopSleep });
  await flow.requestNumber('tab-1');

  const r1 = await flow.notifyResendClicked('tab-1');
  assert.equal(r1.allowMore, true);
  assert.deepEqual(sms.calls.setStatus[0], { id: '111', status: 3 });

  const r2 = await flow.notifyResendClicked('tab-1');
  assert.equal(r2.allowMore, false);          // 第二次后达到上限
  assert.deepEqual(sms.calls.setStatus[1], { id: '111', status: 3 });

  const r3 = await flow.notifyResendClicked('tab-1');
  assert.equal(r3.allowMore, false);
  assert.equal(sms.calls.setStatus.length, 2); // 第三次不再调 setStatus(3)
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: FAIL（`flow.notifyResendClicked is not a function`）

- [ ] **Step 3: 实现 notifyResendClicked**

在 `background/phone-verify-flow.js` 的 `requestCode` 下方追加：

```js
    async function notifyResendClicked(tabId) {
      const state = getState(tabId);
      if (!state.activationId) return { allowMore: false };
      if (state.resendCount >= MAX_RESEND_CLICKS) return { allowMore: false };
      try { await herosmsClient.setStatus(state.activationId, 3); } catch (_) {}
      state.resendCount += 1;
      return { allowMore: state.resendCount < MAX_RESEND_CLICKS };
    }
```

把模块 return 加上 `notifyResendClicked`：

```js
    return {
      requestNumber,
      requestCode,
      notifyResendClicked,
      _internalGetState: (tabId) => getState(tabId),
      _internalReset,
      MAX_RESEND_CLICKS,
      MAX_ACTIVATIONS,
    };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/phone-verify-flow.js tests/phone-verify-flow.test.js
git commit -m "feat(phone-verify): 重发上限（最多 2 次）"
```

### Task 4.5：cancel 与 notifyPhoneRejected

**Files:**
- Modify: `background/phone-verify-flow.js`
- Modify: `tests/phone-verify-flow.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/phone-verify-flow.test.js` 末尾追加：

```js
test('cancel releases active activation', async () => {
  const sms = makeHerosmsStub({
    getNumberReplies: [{ id: '111', phone: '+56912' }],
    setStatusReplies: [undefined],
  });
  const flow = createPhoneVerifyFlow({ herosmsClient: sms.client, sleep: noopSleep });
  await flow.requestNumber('tab-1');
  await flow.cancel('tab-1');
  assert.deepEqual(sms.calls.setStatus[0], { id: '111', status: 8 });
});

test('cancel is safe when no active activation', async () => {
  const sms = makeHerosmsStub({});
  const flow = createPhoneVerifyFlow({ herosmsClient: sms.client, sleep: noopSleep });
  await flow.cancel('unknown-tab');                 // 不应抛
  assert.equal(sms.calls.setStatus.length, 0);
});

test('notifyPhoneRejected triggers number switch without consuming resendCount', async () => {
  const sms = makeHerosmsStub({
    getNumberReplies: [
      { id: '111', phone: '+56912' },
      { id: '222', phone: '+5511' },
    ],
    setStatusReplies: [undefined],
  });
  const newNumbers = [];
  const flow = createPhoneVerifyFlow({
    herosmsClient: sms.client,
    sleep: noopSleep,
    onNewNumber: async (info) => { newNumbers.push(info); },
  });

  await flow.requestNumber('tab-1');
  const r = await flow.notifyPhoneRejected('tab-1');

  assert.equal(r.phone, '+5511');
  assert.deepEqual(sms.calls.setStatus[0], { id: '111', status: 8 });
  assert.equal(flow._internalGetState('tab-1').resendCount, 0);
  assert.equal(newNumbers.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: FAIL（`flow.cancel is not a function`）

- [ ] **Step 3: 实现 cancel / notifyPhoneRejected**

在 `background/phone-verify-flow.js` 的 `notifyResendClicked` 下方追加：

```js
    async function notifyPhoneRejected(tabId) {
      const state = getState(tabId);
      await cancelActivation(state);
      if (state.activationCount >= MAX_ACTIVATIONS) {
        const e = new Error('已用尽可换号配额'); e.code = 'ACTIVATION_EXHAUSTED'; throw e;
      }
      const next = await tryGetNumber(state);
      await onNewNumber({ phone: next.phone, country: next.country });
      return next;
    }

    async function cancel(tabId) {
      const state = states.get(tabId);
      if (!state) return;
      state.pollAbort = true;
      await cancelActivation(state);
      states.delete(tabId);
    }
```

把模块 return 加上：

```js
    return {
      requestNumber,
      requestCode,
      notifyResendClicked,
      notifyPhoneRejected,
      cancel,
      _internalGetState: (tabId) => getState(tabId),
      _internalReset,
      MAX_RESEND_CLICKS,
      MAX_ACTIVATIONS,
    };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -- tests/phone-verify-flow.test.js
```

Expected: PASS（共 9 tests）

- [ ] **Step 5: Commit**

```bash
git add background/phone-verify-flow.js tests/phone-verify-flow.test.js
git commit -m "feat(phone-verify): cancel 与 notifyPhoneRejected"
```

---

## Phase 5：背景脚本集成

### Task 5.1：在 background.js 头部加载新模块并挂模块入口

**Files:**
- Modify: `background.js:1-130`

- [ ] **Step 1: 找到当前 importScripts 段**

```bash
grep -n "importScripts" background.js | head -5
```

应该能定位到 `importScripts(...)` 调用（service worker 顶层）。

- [ ] **Step 2: 在 importScripts 列表里追加新文件**

把 `importScripts(...)` 调用中已有的脚本列表末尾追加 3 项（保持现有顺序，逗号分隔）：

```js
  'background/herosms-client.js',
  'background/phone-verify-flow.js',
  'background/accounts-exporter.js',
```

- [ ] **Step 3: 在 background.js 合适位置（其它 helper 创建之后，message-router 创建之前）加上模块实例化**

定位包含 `createMessageRouter` 调用的代码块。在其前面插入：

```js
const herosmsModule = self.MultiPageHerosmsClient;
const phoneVerifyModule = self.MultiPagePhoneVerifyFlow;
const accountsExporterModule = self.MultiPageAccountsExporter;

let herosmsClientInstance = null;
function getHerosmsClient(apiKey) {
  if (herosmsClientInstance && herosmsClientInstance._apiKey === apiKey) {
    return herosmsClientInstance;
  }
  herosmsClientInstance = herosmsModule.createHerosmsClient({ apiKey });
  herosmsClientInstance._apiKey = apiKey;
  return herosmsClientInstance;
}

async function readHerosmsConfig() {
  const { herosmsApiKey, herosmsCountryPreference } = await chrome.storage.local.get([
    'herosmsApiKey', 'herosmsCountryPreference',
  ]);
  return {
    apiKey: String(herosmsApiKey || '').trim(),
    preference: Array.isArray(herosmsCountryPreference) && herosmsCountryPreference.length
      ? herosmsCountryPreference
      : [herosmsModule.COUNTRY_CODES.CHILE, herosmsModule.COUNTRY_CODES.BRAZIL, herosmsModule.COUNTRY_CODES.UK],
  };
}

let phoneVerifyFlowInstance = null;
async function getPhoneVerifyFlow() {
  if (phoneVerifyFlowInstance) return phoneVerifyFlowInstance;
  const { apiKey, preference } = await readHerosmsConfig();
  if (!apiKey) {
    throw new Error('请先在侧边栏配置 HeroSMS API Key。');
  }
  phoneVerifyFlowInstance = phoneVerifyModule.createPhoneVerifyFlow({
    herosmsClient: getHerosmsClient(apiKey),
    getCountryPreference: () => preference,
    service: herosmsModule.SERVICE_OPENAI,
    addLog,
    onNewNumber: async ({ phone }) => {
      const tabId = await getTabId('signup-page');
      if (!tabId) return;
      try {
        await sendToContentScript('signup-page', {
          type: 'PHONE_VERIFY_NEW_NUMBER',
          source: 'background',
          payload: { phone },
        });
      } catch (_) {}
    },
  });
  return phoneVerifyFlowInstance;
}

const accountsExporter = accountsExporterModule.createAccountsExporter({
  chromeStorage: chrome.storage.local,
  chromeDownloads: chrome.downloads,
});
```

> 注：`addLog`、`getTabId`、`sendToContentScript`、`chrome` 在 background.js 上下文中已可用。如果某个变量名在你具体的 background.js 中名字不同，按本地实际命名替换。

- [ ] **Step 4: 重新加载扩展，验证 service worker 启动无报错**

`chrome://extensions` → 重新加载 → 点「Service Worker」打开日志。日志末尾不应有 "is not defined" 或 "Cannot read property" 错误。

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "feat(background): 装载 herosms-client / phone-verify-flow / accounts-exporter 模块"
```

### Task 5.2：在 message-router 注册 PHONE_VERIFY_* 路由

**Files:**
- Modify: `background/message-router.js`

- [ ] **Step 1: 定位 router 的 switch 块**

```bash
grep -n "case 'STEP_ERROR'" background/message-router.js
```

记下行号 N（约 261）。后面紧跟许多 case；找一段语义相邻的位置（例如 `STEP_COMPLETE` 之后）。

- [ ] **Step 2: 在 switch 块中追加 4 个 case**

在 `case 'STEP_ERROR': { ... break; }` 之后插入：

```js
        case 'PHONE_VERIFY_REQUEST_NUMBER': {
          try {
            const flow = await getPhoneVerifyFlow();
            const tabId = sender?.tab?.id;
            const r = await flow.requestNumber(tabId);
            sendResponse({ ok: true, phone: r.phone, country: r.country });
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err), code: err?.code });
          }
          return true;
        }
        case 'PHONE_VERIFY_REQUEST_CODE': {
          try {
            const flow = await getPhoneVerifyFlow();
            const tabId = sender?.tab?.id;
            const r = await flow.requestCode(tabId);
            sendResponse({ ok: true, code: r.code });
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err), code: err?.code });
          }
          return true;
        }
        case 'PHONE_VERIFY_RESEND_CLICKED': {
          try {
            const flow = await getPhoneVerifyFlow();
            const tabId = sender?.tab?.id;
            const r = await flow.notifyResendClicked(tabId);
            sendResponse({ ok: true, allowMore: r.allowMore });
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
          return true;
        }
        case 'PHONE_VERIFY_PHONE_REJECTED': {
          try {
            const flow = await getPhoneVerifyFlow();
            const tabId = sender?.tab?.id;
            const r = await flow.notifyPhoneRejected(tabId);
            sendResponse({ ok: true, phone: r.phone });
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
          return true;
        }
```

注意：`getPhoneVerifyFlow` 是在 background.js 顶层定义的；为让 message-router 模块能拿到它，需要把它作为依赖传入：

打开 `background/message-router.js` 顶部的 `createMessageRouter(deps = {})` / `function createMessageRouterModule(deps = {})`（按文件实际结构），在解构 deps 时加入：

```js
      getPhoneVerifyFlow,
```

并在 background.js 中找到调用 `createMessageRouter({...})` 或 `attachBackgroundMessageRouter({...})` 的地方，在传参对象里加：

```js
      getPhoneVerifyFlow,
```

- [ ] **Step 3: 重新加载扩展，确认 service worker 无报错**

`chrome://extensions` → 重新加载。

- [ ] **Step 4: Commit**

```bash
git add background/message-router.js background.js
git commit -m "feat(message-router): PHONE_VERIFY_* 路由"
```

### Task 5.3：注册成功后写 accounts.txt

**Files:**
- Modify: `background.js`（在 auto-run-controller 通知「11 步成功」的回调里）

- [ ] **Step 1: 定位注册成功收尾处**

```bash
grep -n "finalizeIcloudAliasAfterSuccessfulFlow\|stepStatuses.*11\|autoRunRoundSummaries" background.js | head -10
```

会得到几个候选位置。找到 `finalizeIcloudAliasAfterSuccessfulFlow(state)` 被调用的那一行（一个轮成功收尾）。

- [ ] **Step 2: 在 `finalizeIcloudAliasAfterSuccessfulFlow` 之后追加 accountsExporter.appendAccount**

把那一段调用：

```js
await finalizeIcloudAliasAfterSuccessfulFlow(state);
```

替换为：

```js
await finalizeIcloudAliasAfterSuccessfulFlow(state);

try {
  const email = String(state?.email || '').trim();
  const password = String(state?.password || state?.customPassword || '').trim();
  if (email && password) {
    await accountsExporter.appendAccount({ email, password });
    await addLog(`accounts.txt：已写入 ${email}`, 'ok');
  } else {
    await addLog('accounts.txt：跳过写入（缺少 email 或 password）', 'warn');
  }
} catch (err) {
  await addLog(`accounts.txt：写入失败 ${err?.message || err}`, 'warn');
}
```

> 字段名 `state.password` 在不同分支可能是 `state.customPassword` 或 `state.generatedPassword`。若都不存在，先在 background.js 里 `grep -n "password" background.js | head -10` 确认实际字段，再选用。

- [ ] **Step 3: 重新加载扩展**

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat(background): 注册成功后追加 accounts.txt"
```

### Task 5.4：注册流程被停止时释放 phone-verify 状态

**Files:**
- Modify: `background.js`（停止流程的入口）

- [ ] **Step 1: 定位停止处理**

```bash
grep -n "broadcastStopToContentScripts\|stopRequested\s*=\s*true" background.js | head -5
```

- [ ] **Step 2: 在 `broadcastStopToContentScripts` 之前/之后追加：**

```js
// 释放当前 phone-verify 状态（避免余额浪费）
try {
  if (phoneVerifyFlowInstance) {
    const tabId = await getTabId('signup-page');
    if (tabId) await phoneVerifyFlowInstance.cancel(tabId);
  }
} catch (_) {}
```

- [ ] **Step 3: 重新加载扩展**

- [ ] **Step 4: Commit**

```bash
git add background.js
git commit -m "feat(background): 停止时释放 herosms 激活"
```

---

## Phase 6：content/signup-page.js 改造

### Task 6.1：在检测到 add_phone_page 时不再 throw，转为 SMS 流程

**Files:**
- Modify: `content/signup-page.js`

> 注：signup-page.js 较大（2545 行）。本任务只**新增**一个 SMS 处理函数，并在原 `trySkipAddPhonePage` 没找到「跳过」按钮的分支调用它。先不动既有 throw 错误信息的多个位置（那些大多在「期望流程不出现 phone 页」的护栏里，留给手机号验证完成后还是失败的兜底）。

- [ ] **Step 1: 在 signup-page.js 顶部（其它 const 之后）加入辅助函数：**

定位 `function isAddPhonePageReady()`（约 764 行），在其上方插入：

```js
async function runHerosmsPhoneVerification(step) {
  log('手机验证：开始 HeroSMS 短信验证流程', 'info');

  // 1) 取号
  const reqNum = await chrome.runtime.sendMessage({ type: 'PHONE_VERIFY_REQUEST_NUMBER', source: 'content' });
  if (!reqNum?.ok) {
    throw new Error(`手机验证取号失败：${reqNum?.error || 'unknown'}`);
  }
  log(`手机验证：获得号码 ${reqNum.phone}（国家 ${reqNum.country}）`, 'ok');

  // 2) 填手机号到输入框
  await fillPhoneNumberAndSubmit(reqNum.phone);

  // 3) 监听重发点击 + 监听 OpenAI 拒绝
  attachResendListener();
  attachPhoneRejectionListener();

  // 4) 后台监听新号事件（换号时收到）
  const newNumberListener = (message) => {
    if (message?.type === 'PHONE_VERIFY_NEW_NUMBER' && message?.payload?.phone) {
      log(`手机验证：换号到 ${message.payload.phone}，重新填入`, 'warn');
      fillPhoneNumberAndSubmit(message.payload.phone).catch((err) => log(`手机验证：重填失败 ${err.message}`, 'warn'));
    }
  };
  chrome.runtime.onMessage.addListener(newNumberListener);

  try {
    // 5) 阻塞等待验证码（背景可能内部换多次号）
    const reqCode = await chrome.runtime.sendMessage({ type: 'PHONE_VERIFY_REQUEST_CODE', source: 'content' });
    if (!reqCode?.ok) {
      throw new Error(`手机验证拿码失败：${reqCode?.error || 'unknown'}（code=${reqCode?.code || ''}）`);
    }
    log(`手机验证：收到验证码 ${reqCode.code}`, 'ok');

    // 6) 填写验证码并提交
    await fillSmsCodeAndSubmit(reqCode.code);
    log('手机验证：完成', 'ok');
  } finally {
    chrome.runtime.onMessage.removeListener(newNumberListener);
  }
}

async function fillPhoneNumberAndSubmit(phone) {
  const input = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
  );
  if (!input || !isVisibleElement(input)) {
    throw new Error('找不到手机号输入框');
  }
  input.focus();
  setNativeInputValue(input, phone);                  // 复用现有工具
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await humanPause(400, 900);
  const submitBtn = getPrimaryContinueButton();
  if (!submitBtn) throw new Error('找不到手机号提交按钮');
  simulateClick(submitBtn);
  await sleep(1500);
}

async function fillSmsCodeAndSubmit(code) {
  const input = document.querySelector(
    'input[type="tel"][maxlength="6"], input[name*="code" i], input[id*="code" i], input[autocomplete="one-time-code"]'
  );
  if (!input || !isVisibleElement(input)) {
    throw new Error('找不到 SMS 验证码输入框');
  }
  input.focus();
  setNativeInputValue(input, code);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await humanPause(400, 900);
  const submitBtn = getPrimaryContinueButton();
  if (submitBtn) simulateClick(submitBtn);
  await sleep(1500);
}

function attachResendListener() {
  if (window.__codexResendListenerAttached) return;
  window.__codexResendListenerAttached = true;
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const text = (target.textContent || '').trim();
    const aria = (target.getAttribute('aria-label') || '').trim();
    if (/resend|重发|重新发送/i.test(text) || /resend/i.test(aria)) {
      chrome.runtime.sendMessage({ type: 'PHONE_VERIFY_RESEND_CLICKED', source: 'content' }).catch(() => {});
    }
  }, true);
}

function attachPhoneRejectionListener() {
  if (window.__codexPhoneRejectListenerAttached) return;
  window.__codexPhoneRejectListenerAttached = true;
  const observer = new MutationObserver(() => {
    const snapshot = getPageTextSnapshot();
    if (/already.*used|invalid.*phone|无效.*手机|号码.*已.*使用/i.test(snapshot)) {
      chrome.runtime.sendMessage({ type: 'PHONE_VERIFY_PHONE_REJECTED', source: 'content' }).catch(() => {});
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
```

- [ ] **Step 2: 修改 `trySkipAddPhonePage` 在「找不到跳过按钮」分支处调用 SMS 流程**

找到 `trySkipAddPhonePage`（约 778 行）的 `if (skipBtn) { ... return true; }` 之后那段：

```js
  log('检测到手机号页面，未找到跳过按钮，等待 background 重新导航...', 'warn');
  return false;
```

替换为：

```js
  log('检测到手机号页面，未找到跳过按钮，启动 HeroSMS 短信验证流程...', 'warn');
  try {
    await runHerosmsPhoneVerification();
    return true;     // SMS 走完，认为该页已通过
  } catch (err) {
    log(`手机验证失败：${err.message}`, 'warn');
    return false;
  }
```

- [ ] **Step 3: 重新加载扩展**

- [ ] **Step 4: Commit**

```bash
git add content/signup-page.js
git commit -m "feat(signup-page): add_phone_page 触发 HeroSMS 短信验证流程"
```

### Task 6.2：放宽既有「禁止进入 phone 页」的护栏

> signup-page.js 在 6 处地方（约 1424、1702、1744、1826、1872、1944、1967 行）当 snapshot.state === 'add_phone_page' 时 throw error。这些是为了在「不该出现 phone 页」的步骤抛错；引入 SMS 后，凡是 4-7 步之间允许 phone 页出现的地方应该容许。

**Files:**
- Modify: `content/signup-page.js`

- [ ] **Step 1: 列出所有「add_phone_page」相关的 throw**

```bash
grep -n "add_phone_page" content/signup-page.js
```

- [ ] **Step 2: 逐一检视，把 throw 改为「调用 runHerosmsPhoneVerification 后返回 true」**

针对每一处形如：

```js
if (snapshot.state === 'add_phone_page') {
  throw new Error(`提交邮箱后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
}
```

改为：

```js
if (snapshot.state === 'add_phone_page') {
  log('检测到提前进入手机号页面，启动 HeroSMS 短信验证...', 'warn');
  await runHerosmsPhoneVerification();
  return;                    // 调用方继续后续步骤
}
```

注意：保留**步骤 9（OAuth 同意页）**的护栏（行 2222 附近），因为同意页不应该是 phone 页：

```js
throw new Error('当前页面已进入手机号页面，不是 OAuth 授权同意页。URL: ' + location.href);
```

这一处**不要改**。

- [ ] **Step 3: 重新加载扩展**

- [ ] **Step 4: Commit**

```bash
git add content/signup-page.js
git commit -m "feat(signup-page): phone-page 护栏改为触发 SMS 流程（保留 OAuth 同意页护栏）"
```

---

## Phase 7：侧边栏 HeroSMS 配置 UI

### Task 7.1：在 sidepanel.html 加 HeroSMS 配置卡片

**Files:**
- Modify: `sidepanel/sidepanel.html`

- [ ] **Step 1: 在 `icloud-section` 后插入 HeroSMS 卡片**

定位 `<div id="icloud-section" class="data-card hotmail-card" style="display:none;">` 的关闭 `</div>`（约第 589 行）。在它后面插入：

```html
    <div id="herosms-section" class="data-card hotmail-card">
      <div class="section-mini-header">
        <div class="section-mini-copy">
          <span class="section-label">HeroSMS 短信验证</span>
        </div>
        <div class="section-mini-actions">
          <button id="btn-herosms-test" class="btn btn-ghost btn-xs" type="button">查余额</button>
          <button id="btn-accounts-reexport" class="btn btn-ghost btn-xs" type="button">重新导出 accounts.txt</button>
        </div>
      </div>
      <div class="data-row">
        <span class="data-label">API Key</span>
        <input type="password" id="input-herosms-api-key" class="data-input mono" placeholder="hero-sms.com 的 API Key" />
      </div>
      <div class="data-row">
        <span class="data-label">国家偏好</span>
        <select id="select-herosms-country-pref" class="data-select">
          <option value="151,73,16">智利 → 巴西 → 英国</option>
          <option value="73,151,16">巴西 → 智利 → 英国</option>
          <option value="16,151,73">英国 → 智利 → 巴西</option>
        </select>
      </div>
      <div id="herosms-status" class="data-row" style="opacity:.7;">
        <span class="data-label">状态</span>
        <span id="herosms-status-text">未配置</span>
      </div>
    </div>
```

- [ ] **Step 2: 重新加载扩展，打开侧边栏确认 HeroSMS 卡片正常显示**

- [ ] **Step 3: Commit**

```bash
git add sidepanel/sidepanel.html
git commit -m "feat(sidepanel): 加入 HeroSMS 配置卡片"
```

### Task 7.2：在 sidepanel.js 读写 HeroSMS 配置

**Files:**
- Modify: `sidepanel/sidepanel.js`

- [ ] **Step 1: 在 sidepanel.js 的初始化函数（绑定 DOM 监听处）追加**

```bash
grep -n "select-icloud-host-preference\|btn-icloud-refresh\|loadIcloudAliases" sidepanel/sidepanel.js | head -5
```

记下一个稳定的初始化位置（例如 iCloud 监听绑定附近）。在 iCloud 监听代码块后追加：

```js
const herosmsApiKeyInput = document.getElementById('input-herosms-api-key');
const herosmsCountryPrefSelect = document.getElementById('select-herosms-country-pref');
const herosmsStatusText = document.getElementById('herosms-status-text');
const btnHerosmsTest = document.getElementById('btn-herosms-test');
const btnAccountsReexport = document.getElementById('btn-accounts-reexport');

async function loadHerosmsConfig() {
  const { herosmsApiKey = '', herosmsCountryPreference = [151, 73, 16] } =
    await chrome.storage.local.get(['herosmsApiKey', 'herosmsCountryPreference']);
  herosmsApiKeyInput.value = herosmsApiKey;
  herosmsCountryPrefSelect.value = herosmsCountryPreference.join(',');
  herosmsStatusText.textContent = herosmsApiKey ? '已配置' : '未配置';
}

herosmsApiKeyInput?.addEventListener('change', async () => {
  await chrome.storage.local.set({ herosmsApiKey: herosmsApiKeyInput.value.trim() });
  herosmsStatusText.textContent = herosmsApiKeyInput.value.trim() ? '已配置' : '未配置';
});

herosmsCountryPrefSelect?.addEventListener('change', async () => {
  const value = herosmsCountryPrefSelect.value.split(',').map((v) => parseInt(v, 10)).filter(Boolean);
  await chrome.storage.local.set({ herosmsCountryPreference: value });
});

btnHerosmsTest?.addEventListener('click', async () => {
  const apiKey = herosmsApiKeyInput.value.trim();
  if (!apiKey) {
    herosmsStatusText.textContent = '请先填 API Key';
    return;
  }
  herosmsStatusText.textContent = '查询中...';
  try {
    const resp = await fetch(`https://hero-sms.com/stubs/handler_api.php?api_key=${encodeURIComponent(apiKey)}&action=getBalance`);
    const text = (await resp.text()).trim();
    if (text.startsWith('ACCESS_BALANCE:')) {
      herosmsStatusText.textContent = `余额 ${text.split(':')[1]}`;
    } else {
      herosmsStatusText.textContent = `API 返回：${text}`;
    }
  } catch (err) {
    herosmsStatusText.textContent = `网络错误：${err.message}`;
  }
});

btnAccountsReexport?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ACCOUNTS_REEXPORT', source: 'sidepanel' });
});

loadHerosmsConfig();
```

- [ ] **Step 2: 在 background/message-router.js 加 ACCOUNTS_REEXPORT 路由**

打开 `background/message-router.js`，在 `PHONE_VERIFY_PHONE_REJECTED` case 之后追加：

```js
        case 'ACCOUNTS_REEXPORT': {
          try {
            const r = await accountsExporter.reexportAll();
            sendResponse({ ok: true, saved: r.saved });
          } catch (err) {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
          return true;
        }
```

并在 `createMessageRouter(deps = {})` 的 deps 解构中加入 `accountsExporter`，在 background.js 调 message-router 处传入。

- [ ] **Step 3: 重新加载扩展，打开侧边栏 → 填入 API Key → 点「查余额」**

Expected：「状态」区显示「余额 X.XX」（如果 key 有效）。

- [ ] **Step 4: Commit**

```bash
git add sidepanel/sidepanel.js background/message-router.js background.js
git commit -m "feat(sidepanel): HeroSMS 配置读写 + 余额检测 + accounts 重新导出"
```

### Task 7.3：emailGenerator 默认值改为 icloud

**Files:**
- Modify: `sidepanel/sidepanel.js`

- [ ] **Step 1: 定位 emailGenerator 默认设置**

```bash
grep -n "emailGenerator\s*[=:]\s*['\"]" sidepanel/sidepanel.js | head -10
```

- [ ] **Step 2: 把默认值改为 'icloud'**

把当前默认（例如 `'duck'` 或 `'custom'`）改成 `'icloud'`。具体行需要按 grep 结果定位；通常出现在「初始 state」或「未持久化时回退」的地方。

- [ ] **Step 3: 重新加载扩展，**

打开侧边栏，确认「邮箱生成方式」下拉默认选「iCloud 隐私邮箱」。已有用户的 chrome.storage 不应被覆盖。

- [ ] **Step 4: Commit**

```bash
git add sidepanel/sidepanel.js
git commit -m "feat(sidepanel): emailGenerator 默认改为 icloud"
```

---

## Phase 8：清理 + 验收

### Task 8.1：跑全部测试

- [ ] **Step 1: 完整测试套件**

```bash
npm test
```

Expected：所有测试 PASS。如果有现有用例因 `add_phone_page → throw` 的旧路径失败，按 Phase 6 改动的逻辑更新或删除：

```bash
grep -rn "add_phone_page" tests/ | head
```

针对每条相关用例，把「期望 throw」改为「期望调用 PHONE_VERIFY_REQUEST_NUMBER」。

- [ ] **Step 2: 修复任何失败用例（若有）**

如果 `tests/auto-run-add-phone-stop.test.js` 因新行为变更失败：现行预期是「进入 phone 页 → 停止」，新行为是「进入 phone 页 → SMS 流程」。可以在 mock 里把 herosms 客户端注入失败响应，把这条用例改为「SMS 失败时停止」的语义。

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test: 更新 add_phone_page 行为相关用例（改为 SMS 流程）"
```

### Task 8.2：端到端手动验收

- [ ] **Step 1: 准备**

- 侧边栏填 HeroSMS API Key
- 国家偏好选「智利 → 巴西 → 英国」
- 邮箱生成方式选 iCloud（确保 iCloud 已在浏览器中登录）
- 点「查余额」确认 ≥ 1 USD

- [ ] **Step 2: 启动一次注册**

「运行次数 = 1」→ 点「自动」。

观察 service worker 日志（chrome://extensions → Service Worker → 查看视图）：

- 应依次看到：iCloud 选号 / 生成 → 邮箱验证码 → 出生日期 → 进入手机号页 → HeroSMS 取号 → 填手机号 → 收到 SMS 验证码 → OAuth 完成

- [ ] **Step 3: 验证 accounts.txt**

```bash
cat ~/Downloads/accounts.txt
```

Expected: 1 行 `email----password`。

- [ ] **Step 4: 再次运行注册**

启动「运行次数 = 1」第二次。完成后：

```bash
cat ~/Downloads/accounts.txt
```

Expected: 2 行，第二行新账号。

- [ ] **Step 5: 强制换号路径**

在 OpenAI 注册到「输入 SMS 验证码」页面时，主动点 2 次「重发」按钮但不实际填码。等待 background 自动换号（看日志出现「尝试换号」）。

- [ ] **Step 6: 强制失败路径**

把 HeroSMS API Key 故意改成错的（保留侧边栏配置）→ 启动注册 → 日志应在 phone-verify 阶段立即提示「请先在侧边栏配置 HeroSMS API Key」或「BAD_KEY」。

- [ ] **Step 7: 提交 release commit**

```bash
git status
git commit --allow-empty -m "release: codex 注册机增强 v1（HeroSMS + 反检测 + accounts.txt）"
```

---

## 自审清单（写完后逐项核对）

- [ ] manifest 增加了 `downloads` 权限并保留所有原有权限
- [ ] manifest 增加了 MAIN-world 注入入口，且 matches 只覆盖 `auth*.openai.com`
- [ ] herosms-client 单元测试覆盖：URL 构造、getNumber 成功、4 种错误码、getStatus 4 种状态、setStatus 4 种成功响应、常量导出
- [ ] phone-verify-flow 单元测试覆盖：基础取号、国家 fallback、全部 NO_NUMBERS、轮询成功、超时换号、ACTIVATION_EXHAUSTED、resendCount 上限、cancel、notifyPhoneRejected
- [ ] accounts-exporter 单元测试覆盖：单条 append、累积 append、reexportAll、空 list、入参校验
- [ ] signup-page.js：trySkipAddPhonePage 的「找不到 skip 按钮」分支改为触发 SMS；6 处 add_phone_page throw 改为触发 SMS；OAuth 同意页那条护栏保留
- [ ] message-router 注册了 4 个 PHONE_VERIFY_* + ACCOUNTS_REEXPORT
- [ ] background.js 在注册成功收尾处调 accountsExporter.appendAccount
- [ ] background.js 在 stop 流程里 cancel phone-verify 状态
- [ ] sidepanel 加了 HeroSMS 配置卡片，并在 chrome.storage.local 持久化 herosmsApiKey + herosmsCountryPreference
- [ ] emailGenerator 默认值改为 'icloud'
- [ ] 所有 commit message 描述清晰
- [ ] `npm test` 全绿
