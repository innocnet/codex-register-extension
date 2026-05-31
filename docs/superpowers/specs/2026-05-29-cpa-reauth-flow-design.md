# CPA 账号重新授权流程 — 设计文档

日期：2026-05-29
分支：`feature/reauth-flow`（基于 `codex-register-extension/feature/codex-register-enhance`）

## 1. 背景与目标

部分账号虽然已接码注册并导入 CPA，但会掉登录、需要重新认证。其中一部分可以重新授权，另一部分在重新授权时会触发手机验证码二次验证——这类基本无法验证，应直接废弃。

本功能提供「重新授权」能力：识别 CPA 里的异常账号，并对其走**邮箱登录**重新授权（而非注册新账号）。

范围限定：**仅处理 CPA（`vpsUrl` / vps-panel 这条线）**，不涉及 SUB2API。

### 目标拆解

- 支持两种账号来源：
  - **自动拉取**：从 CPA 后台拉账号列表，逐个探活，识别异常账号。
  - **手动指定**：用户在侧边栏粘贴邮箱列表。
- 重新授权 = 复用现有 **step 7 → 8 → 9 → 10** 完整链路（OAuth 登录 → 登录验证码 → 确认 OAuth → CPA 回调），跳过注册的 step 1~6。
- 执行方式：**手动逐条触发**（每行一个「重授权」按钮），保险起见不做全自动批量。
- 遇到手机二次验证：该账号废弃——在 CPA 后台**禁用该账号并备注 `sms-failed`**，跳过。
- 密码来源：**固定统一密码**（侧边栏 `customPassword`）。

## 2. 异常判定策略

CPA 后台没有可靠的「异常」状态字段。采用探活方式：

> 调用 CPA 的「刷新额度」接口，返回 **401** 即判定账号掉登录、需要重新授权。

## 3. 架构

```
侧边栏「重新授权」区块
  │  ① 点「拉取异常账号」        ② 手动粘贴邮箱列表
  ▼                              ▼
后台 message-router（新增 message type）
  │
  ├─ REAUTH_FETCH_ABNORMAL ──► cpa-admin-client.listAbnormalAccounts()
  │                              ├─ listAccounts()
  │                              └─ 对每个账号 probeAccount()（调刷新额度，401=异常）
  │                              返回异常账号 [{id, email, ...}]
  │
  └─ REAUTH_RUN_ACCOUNT(email, accountId) ──► reauth-orchestrator.runForAccount()
        │  注入 state {email, password: 固定密码, panelMode:'cpa', signupPhone:null}
        │  顺序执行 step7 → step8 → step9 → step10（复用现有执行器）
        │  成功 → 写成功历史
        └─ 捕获手机二次验证 → cpa-admin-client.disableAccount(id, 'sms-failed') → 标记跳过
```

### 新增模块与接入点

1. `background/cpa-admin-client.js` —— 纯逻辑 CPA 接口客户端（可单测）
2. `background/reauth-orchestrator.js` —— 单账号重授权编排
3. 侧边栏「重新授权」区块（HTML + JS）
4. `background/message-router.js` 新增 2 个 message type
5. `background.js` 装配上述模块

### 已核实的有利前提

- `manifest.json` 的 `host_permissions` 含 `<all_urls>` —— 后台可直接 `fetch` CPA 接口，无需开标签页。
- step 7（`background/steps/oauth-login.js`）内部已会调 `refreshOAuthUrlBeforeStep6`，自动从 CPA 拉最新 OAuth 链接。
- step 7 的 `loginIdentifier = state.signupPhone || state.email`：清空 `signupPhone` 即可强制走邮箱登录。
- step7 已有 `isAddPhoneAuthFailure(err)` 判定手机二次验证，可复用。
- 步骤映射：7=oauth-login / 8=fetch-login-code / 9=confirm-oauth / 10=platform-verify（见 background.js 步骤 key 表）。

## 4. CPA Admin 客户端（`background/cpa-admin-client.js`）

纯逻辑工厂模块，模式对齐 `background/herosms-client.js`，注入 `fetch` 便于单测。

```js
createCpaAdminClient({ fetch, baseUrl, managementKey })
```

- `baseUrl`：从侧边栏 CPA 地址（如 `http(s)://host/management.html#/oauth`）取 `origin`。
- 鉴权：**管理密钥直接当 token**。具体放哪个请求头需联调钉死（大概率 `Authorization: Bearer <key>`，或 new-api 风格的 key 头）。先用一个集中的常量/构造函数封装。

### 方法

| 方法 | 作用 | 异常判定 |
|---|---|---|
| `listAccounts()` | 拉全部 CPA 账号 `[{id, email, ...}]` | — |
| `probeAccount(id)` | 调「刷新额度」接口探活 | **401 → `{abnormal:true}`**；2xx → 正常；其他 → `{error}` |
| `disableAccount(id, note)` | 禁用账号 + 写备注（note 用于 `sms-failed`） | — |
| `listAbnormalAccounts()` | `listAccounts()` 后逐个 `probeAccount`，汇总 401 的账号 | 默认串行（避免打爆），可选间隔 |

### 错误处理

- 网络错误 / 非预期状态码 → 抛带上下文的 Error。
- 401 在 `probeAccount` 中是**业务信号**（不抛错）；在 `listAccounts` / `disableAccount` 中视为鉴权失败（抛错）。

## 5. 重授权编排器（`background/reauth-orchestrator.js`）

纯逻辑工厂模块，不碰 auto-run 状态机。

```js
createReauthOrchestrator({
  getState, setState, addLog,
  executeStep,            // 复用现有步骤执行
  cpaAdminClient,         // 用于 sms-failed 禁用
  isAddPhoneAuthFailure,  // 复用 step7 已有的手机验证判定
  getFixedPassword,       // 取固定统一密码（customPassword）
})
```

### `runForAccount({ email, accountId })`

```
1. 注入运行上下文：setState({
     email, password: 固定密码,
     panelMode: 'cpa',
     signupPhone: null,        // 关键：清掉手机号，强制走邮箱登录
     signupPhoneCountry: null,
   })
   + 重置 step7~10 的 stepStatuses

2. 依次 await executeStep(7) → 8 → 9 → 10
   （step7 内部已自动 refreshOAuthUrlBeforeStep6 拉最新 OAuth 链接）

3. 成功 → 写成功历史（复用 accountRunHistory，邮箱主键）
        → 返回 { status: 'success', email }

4. catch：
   ├─ isAddPhoneAuthFailure(err)?
   │     → 若无 accountId，先用 listAccounts() 按 email 反查 id
   │     → cpaAdminClient.disableAccount(accountId, 'sms-failed')
   │       （查不到 id 时仅记日志、不禁用）
   │     → addLog '账号触发手机二次验证，已禁用并备注 sms-failed'
   │     → 返回 { status: 'sms-failed', email }
   └─ 其他错误 → addLog 失败 → 返回 { status: 'failed', email, error }
                 （不写历史、不做额外处理，可忽略）
```

### 运行历史策略

- **成功** → 正常写入现有 `accountRunHistory`（邮箱主键）。
- **手机二次验证失败** → CPA 禁用 + 备注 `sms-failed`，日志标记。
- **其他失败** → 仅日志，不写历史、不额外处理。

## 6. 侧边栏「重新授权」区块

在 `sidepanel/sidepanel.html` 新增折叠区块：

```
┌─ 重新授权（CPA）────────────────────┐
│ [拉取异常账号]   ← 调 listAbnormalAccounts │
│ ──────────────────────────────────── │
│ 手动指定（每行一个邮箱）：             │
│ ┌────────────────────────────┐        │
│ │ a@x.com                    │        │
│ │ b@y.com                    │        │
│ └────────────────────────────┘        │
│ [加入列表]                             │
│ ──────────────────────────────────── │
│ 待重授权列表：                         │
│  a@x.com   [重授权]  状态：待处理       │
│  b@y.com   [重授权]  状态：✅ 成功      │
│  c@z.com   [重授权]  状态：⚠ sms-failed │
└────────────────────────────────────────┘
```

- **拉取异常账号**：调 `REAUTH_FETCH_ABNORMAL`，返回异常账号填进列表（带 accountId）。
- **手动加入**：文本框按行解析邮箱，加入同一列表（accountId 为空，触发禁用时后台再反查）。
- **每行「重授权」按钮**：手动逐条触发 `REAUTH_RUN_ACCOUNT`，跑完更新该行状态徽章（待处理 / 运行中 / 成功 / 失败 / sms-failed）。
- **运行中禁用按钮**，防重复点击。
- 重授权过程的 `addLog` 照常显示在现有日志区；列表行只显示最终结果徽章。

### 新增 message types（message-router）

- `REAUTH_FETCH_ABNORMAL` → 返回异常账号数组。
- `REAUTH_RUN_ACCOUNT` `{email, accountId}` → 返回 `{status, email, error?}`。

## 7. 接入（`background.js`）

- `importScripts` 加 `background/cpa-admin-client.js`、`background/reauth-orchestrator.js`。
- 实例化两个模块并注入依赖（`executeStep`、`isAddPhoneAuthFailure`、`customPassword` 取值、`getState`/`setState`/`addLog` 等）。
- 在 message-router 的 deps 挂上 `reauthFetchAbnormal` / `reauthRunAccount` 两个处理函数。

## 8. 测试（TDD，对齐现有 `tests/` 风格）

- `tests/cpa-admin-client.test.js`：
  - `listAccounts` 解析
  - `probeAccount`：401→abnormal / 2xx→正常 / 其他→error
  - `disableAccount` 入参与 body 构造
  - `listAbnormalAccounts` 汇总
  - 鉴权头构造
  - 网络错误抛错
- `tests/reauth-orchestrator.test.js`：
  - 成功路径（7→8→9→10 顺序调用）
  - 手机验证失败 → 调 `disableAccount(sms-failed)`
  - 其他失败 → 仅返回 failed，不禁用
  - 注入 state 时清空 `signupPhone`
  - 手动账号无 id 时先反查
- message-router 新增分支的轻量测试（可选）。

## 9. 联调钉死的未知项

实现 `cpa-admin-client.js` 时，先用浏览器打开 CPA 后台抓真实请求确认，再落到代码。

**当前实现的占位假设**（位于 `background/cpa-admin-client.js` 顶部 `DEFAULTS` + `authHeader`，联调时只改这一处）：

1. 管理密钥请求头：`Authorization: Bearer <key>`。
2. 账号列表：`GET /api/v1/admin/accounts`，解析 `data` / `list` / 顶层数组；字段 `id`、`email`。
3. 「刷新额度」探活：`POST /api/v1/admin/accounts/{id}/refresh`，401 判定异常。
4. 禁用 + 备注：`PUT /api/v1/admin/accounts/{id}`，body `{ status: 'disabled', remark: 'sms-failed' }`。

> ⚠ 这 4 项为合理推断，**尚未对真实 CPA 后端联调验证**。上线前必须用浏览器抓包核对路径、请求头与字段名，并据实修正 `DEFAULTS` / `authHeader` / `disableAccount` body。单元测试覆盖的是解析与分支逻辑，不能替代真实接口验证。
