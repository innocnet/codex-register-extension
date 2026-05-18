# Codex 注册机增强设计

> 状态：草案
> 日期：2026-05-18
> 关联需求：仓库根目录 `requirement.md`

## 1. 目标

在现有 codex-oauth-automation-extension（Chrome MV3 扩展）的注册流程上补齐 4 项能力：

1. **HeroSMS 短信验证**：手机号页面自动取号、读取验证码、号码失效自动换号
2. **过机器检查**：参考 grok-register 的 `turnstilePatch`，修复 CDP 模拟点击的 `MouseEvent.screenX/screenY` 检测
3. **accounts.txt 持久化**：注册成功的账号增量落盘到 `~/Downloads/accounts.txt`
4. **iCloud 自动选号**：复用项目已有的 `fetchIcloudHideMyEmail` 能力，作为默认邮箱来源

需求来源：`requirement.md`：

- 参考 `/Users/april/coding/grok-register` 过机器检查
- 使用本地 iCloud 别名邮箱
- 验证码走 HeroSMS，推荐智利 / 巴西 / 英国
- 号码不可用时通过 HeroSMS 更换
- 发送短信最多两次
- 账号注册成功后保留 `账号+密码` 到 `accounts.txt`，一行一条

## 2. 范围与非目标

**范围内：**

- 在 background 增加 HeroSMS HTTP 客户端与短信验证编排模块
- 修改 `content/signup-page.js` 的手机号页面分支，从「报错终止」改为「触发 SMS 流程」
- 新增 MAIN-world content script 修复 CDP 点击检测
- 新增 `accounts-exporter` 通过 `chrome.downloads` 写 `accounts.txt`
- 侧边栏新增 HeroSMS 配置项（API key、国家偏好、自动选号开关）

**非目标：**

- 不重写现有 11 步主流程的任何步骤逻辑
- 不引入除「MouseEvent.screenX/screenY」之外的反指纹技术（UA、Canvas 等留待后续）
- 不实现 HeroSMS 的高级特性（语音验证、特定运营商、批量号）
- 不修改 iCloud 现有别名生成/复用算法

## 3. 现状速览

| 模块 | 现状 |
|---|---|
| 主注册流程 | `background/steps/` 11 个步骤（registry.js），由 `auto-run-controller` 编排 |
| iCloud 别名 | `background.js:3481 fetchIcloudHideMyEmail`：`v2/hme/list` → 优先复用 → 否则 `v1/hme/generate + v1/hme/reserve`；入口 `background/generated-email-helpers.js:220` |
| 手机号页面 | `content/signup-page.js:612 ADD_PHONE_PAGE_PATTERN` 识别后所有路径都 throw 错误（行 789、1424、1702、1744、1826、1872 等） |
| CDP 点击 | `background.js:4787 clickWithDebugger` 用 `Input.dispatchMouseEvent`，存在 `MouseEvent.screenX === x` 的 Chromium bug，会被 Cloudflare Turnstile 检测 |
| 账号留存 | 仅 `background/account-run-history.js` 写运行历史；无 `accounts.txt` 导出 |
| HeroSMS | 完全无集成 |

## 4. 架构

混合方案：content 检测，background 编排，分层与现有 `signup-flow-helpers.js` / `verification-flow.js` 一致。

```
background/
  herosms-client.js          # NEW HTTP 客户端
  phone-verify-flow.js       # NEW 短信验证子流程编排（非线性，被 content 触发）
  accounts-exporter.js       # NEW 通过 chrome.downloads 追加 accounts.txt
content/
  signup-page.js             # MOD：add_phone_page 触发 PHONE_VERIFY_* 消息
  patches/
    mouse-event-patch.js     # NEW MAIN-world，document_start，作用域 auth*.openai.com
sidepanel/
  sidepanel.html             # MOD：HeroSMS 设置面板
  sidepanel.js               # MOD：HeroSMS 配置读写、emailGenerator 默认值
manifest.json                # MOD：downloads 权限 + 新 content_script 注册
```

### 4.1 HeroSMS 客户端（`background/herosms-client.js`）

封装 sms-activate 协议的 HTTP API：

```
基础 URL：https://hero-sms.com/stubs/handler_api.php
鉴权：query 参数 api_key
通用调用：?api_key=...&action=<action>&<params>

action=getNumber  service=oi country={151|73|16}
  成功响应：ACCESS_NUMBER:<id>:<phone>
  失败响应：NO_NUMBERS / NO_BALANCE / BAD_KEY / BANNED:<until>

action=getStatus  id=<activationId>
  STATUS_WAIT_CODE
  STATUS_WAIT_RETRY:<lastCode>
  STATUS_CANCEL
  STATUS_OK:<code>

action=setStatus  id=<activationId> status={1|3|6|8}
  1 = SMS_SENT（备用）
  3 = REQUEST_RESEND
  6 = COMPLETE
  8 = CANCEL
  响应：ACCESS_READY / ACCESS_RETRY_GET / ACCESS_ACTIVATION / ACCESS_CANCEL
```

国家代号（sms-activate 标准）：
- 智利 = 151
- 巴西 = 73
- 英国 = 16

OpenAI 服务代号 = `oi`

客户端职责：
- 构造 URL、解析 `:` 分隔响应、识别错误码并抛对应 typed error
- 不做轮询、不做状态管理（由 phone-verify-flow 负责）
- 通过 `fetch` 调用，30s timeout，可重试 2 次（网络抖动）

### 4.2 短信验证编排（`background/phone-verify-flow.js`）

#### 4.2.1 状态机

```
状态：
  activationId       当前 HeroSMS 激活 ID
  phone              当前手机号
  countryIndex       偏好列表下标
  resendCount        当前号码已点「重发」次数（OpenAI 页面）
  activationCount    已用号码数（含当前）

事件：
  REQUEST_NUMBER      content 检测到 add_phone_page，请求号码
  REQUEST_CODE        content 提交了手机号，开始轮询验证码
  USER_RESEND_CLICK   content 检测到用户/自动点击「重发」按钮
  POLL_OK(code)       getStatus 返回 STATUS_OK
  POLL_TIMEOUT        getStatus 在 120s 内无 OK
  PHONE_REJECTED      OpenAI 报「号码无效/已使用」
  CANCEL              用户停止 / 上游错误

转移：
  IDLE
    --REQUEST_NUMBER-->
        按 countryIndex 起遍历 [151,73,16] 调 getNumber
        全部 NO_NUMBERS → FAILED
        否则 activationCount++ → WAIT_FILL_PHONE，回传 {id, phone}

  WAIT_FILL_PHONE
    --REQUEST_CODE--> POLLING

  POLLING
    --POLL_OK(code)--> COMPLETE
        setStatus(id, 6) → 调用方继续填验证码
    --USER_RESEND_CLICK-->
        setStatus(id, 3); resendCount++
        resendCount > 2 → SWITCH_NUMBER
        else → 继续 POLLING（同号同 id）
    --POLL_TIMEOUT--> SWITCH_NUMBER
    --PHONE_REJECTED--> SWITCH_NUMBER（不耗 resendCount，因为是号本身的问题）

  SWITCH_NUMBER
    setStatus(prevId, 8); resendCount=0
    if activationCount >= 2 → FAILED
    else → REQUEST_NUMBER（保持 countryIndex；getNumber 失败时 countryIndex++）

  任意状态 --CANCEL-->
    存在活跃 id → setStatus(id, 8)
    → FAILED
```

不变量：
- `resendCount` 严格 ≤ 2，对齐「最多发送两次」
- `activationCount` 严格 ≤ 2，避免无限换号
- 退出（无论成功/失败/取消）前必须释放所有未 complete 的 activation

#### 4.2.2 通信协议

content ↔ background 通过 `chrome.runtime.sendMessage`：

| 方向 | type | payload | 响应 |
|---|---|---|---|
| content → bg | PHONE_VERIFY_REQUEST_NUMBER | `{}` | `{ ok, phone, country }` 或 `{ ok:false, error }` |
| content → bg | PHONE_VERIFY_REQUEST_CODE | `{}` | `{ ok, code }` 或 `{ ok:false, error, action:'switch' }` |
| content → bg | PHONE_VERIFY_RESEND_CLICKED | `{}` | `{ ok, allowMore }`（达到上限时 `allowMore:false`） |
| content → bg | PHONE_VERIFY_PHONE_REJECTED | `{}` | `{ ok }`（背后触发 SWITCH_NUMBER） |
| bg → content | PHONE_VERIFY_NEW_NUMBER | `{ phone }` | content 自动重填手机号 |
| bg → content | PHONE_VERIFY_FAILED | `{ reason }` | content 报错并停止流程 |

bg 在 `phone-verify-flow.js` 内部维护 per-tab 的状态对象，key = tabId。

### 4.3 过机器检查补丁（`content/patches/mouse-event-patch.js`）

逐字复用 grok-register `turnstilePatch/script.js`：

```js
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const screenX = getRandomInt(800, 1200);
const screenY = getRandomInt(400, 600);
Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
```

注入方式（`manifest.json` 新增条目）：

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
}
```

只覆盖 `auth*.openai.com`，缩小爆炸半径。其它已有的 ISOLATED world content scripts 不动。

### 4.4 accounts.txt 导出（`background/accounts-exporter.js`）

MV3 service worker 不支持 `URL.createObjectURL`，用 `data:` URL：

```js
const STORAGE_KEY = 'codexAccountsExport';

async function appendAccount({ email, password }) {
  const { [STORAGE_KEY]: prev = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const next = [...prev, { email, password, savedAt: Date.now() }];
  await chrome.storage.local.set({ [STORAGE_KEY]: next });

  const lines = next.map(a => `${a.email}----${a.password}`).join('\n') + '\n';
  const base64 = btoa(unescape(encodeURIComponent(lines)));
  const dataUrl = `data:text/plain;charset=utf-8;base64,${base64}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: 'accounts.txt',
    conflictAction: 'overwrite',
    saveAs: false,
  });
}
```

- 每次写入「整体覆盖」`Downloads/accounts.txt`，但 storage 保留全量历史，最终文件等价于追加
- 浏览器下载历史会留多条 `accounts.txt` 记录（可接受，亦可在用户设置中关闭下载提示）
- 侧边栏新增「重新导出 accounts.txt」按钮兜底

### 4.5 iCloud 默认选号

无需新增代码，仅做：

- 侧边栏 `selectEmailGenerator` 默认值改为 `'icloud'`
- 自动流程开始时 `fetchGeneratedEmail` 已经会路由到 `fetchIcloudHideMyEmail`，自动「优先复用未用别名 → 否则生成+保留」
- 验收时确认这条链路在自动模式下被实际触发

## 5. 数据流（端到端）

```
sidepanel：用户填 HeroSMS api_key、国家偏好、emailGenerator=icloud → 启动
        │
        ▼
auto-run-controller：step 1 open-chatgpt
        │
        ▼
step 2 submit-signup-email：fetchGeneratedEmail() → fetchIcloudHideMyEmail()
                            → list → 复用未用 / generate+reserve 新别名
                            → state.email
        │
        ▼
step 3-5 邮箱验证码 / 密码 / 出生日期：现有流程
        │
        ▼
signup-page.js 检测到 add_phone_page？──否──→ 继续 step 7+
        │ 是
        ▼
content → bg { PHONE_VERIFY_REQUEST_NUMBER }
        │
        ▼
phone-verify-flow：read api_key, country preference [151,73,16]
                   herosms.getNumber({service:'oi', country})
                   全失败 → bg → content { PHONE_VERIFY_FAILED }
                   成功 → 返回 {id, phone}
        │
        ▼
content 填手机号 → 点提交
        │
        ▼
content → bg { PHONE_VERIFY_REQUEST_CODE }
        │
        ▼
phone-verify-flow：轮询 herosms.getStatus(id) 每 5s，≤120s
        │
   ┌────┼────┬─────────────────────┐
   │    │    │                     │
   ▼    ▼    ▼                     ▼
 OK   USER  TIMEOUT/PHONE        CANCEL
 │    RESEND  REJECTED            │
 │    │     │                     ▼
 │    │     SWITCH_NUMBER         setStatus(id,8) → FAILED
 │    │     setStatus(id,8)
 │    │     activationCount>=2?
 │    │      ├─是 → FAILED
 │    │      └─否 → getNumber 再来 → bg → content
 │    │            { PHONE_VERIFY_NEW_NUMBER }
 │    │
 │    setStatus(id,3); resendCount++
 │    resendCount>2 → SWITCH_NUMBER
 │    else → 继续轮询
 │
 setStatus(id,6) → 返回 code → content 填入
        │
        ▼
继续 step 7-11
        │
        ▼
auto-run-controller 监听 stepCompleted(11) →
  finalizeIcloudAliasAfterSuccessfulFlow（已有）
  accountsExporter.appendAccount({email, password})（新增）
```

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| api_key 未配置 | 注册启动前预检，提示「请在侧边栏配置 HeroSMS API Key」 |
| `NO_BALANCE` | 终止当轮，`accountRunHistory` 标记「失败：HeroSMS 余额不足」 |
| `BAD_KEY` | 终止当轮，提示「HeroSMS API Key 无效」 |
| `BANNED:<until>` | 终止，提示封禁到期时间，引导用户切换 key |
| 当前国 `NO_NUMBERS` | 按偏好顺序 fallback 到下一国 |
| 全部国 `NO_NUMBERS` | 终止，提示「无可用号码，请稍后重试」 |
| OpenAI「号码已使用」 | 走 `SWITCH_NUMBER`，不消耗 `resendCount` |
| `resendCount` 用尽 + activationCount 用尽 | 终止，记失败 |
| 用户中途停止 | 释放当前活跃 activation（setStatus 8），清理 per-tab state |
| `chrome.downloads.download` 失败 | accounts 仍写入 `chrome.storage.local`，侧边栏「重新导出」按钮兜底 |
| `chrome.downloads` 权限被拒 | 提示用户开启权限 |

## 7. 模块边界与接口

### 7.1 herosms-client.js（纯函数 + fetch）

```js
createHerosmsClient({ apiKey, fetchImpl = fetch, timeoutMs = 30000 }) => {
  getBalance(): Promise<number>
  getNumber({ service, country, maxPrice?, operator? }): Promise<{ id, phone }>
  getStatus(id): Promise<{ status: 'wait'|'ok'|'cancel'|'wait_retry', code?: string }>
  setStatus(id, status: 1|3|6|8): Promise<void>
}
错误类型：HerosmsError、NoNumbersError、AuthenticationError、BannedError、NoBalanceError
```

### 7.2 phone-verify-flow.js

```js
createPhoneVerifyFlow({ herosmsClient, getCountryPreference, addLog, sendToContentScript })
  → {
      requestNumber(tabId): Promise<{ phone }>          // 启动状态机
      requestCode(tabId): Promise<{ code }>              // 触发轮询
      notifyResendClicked(tabId): Promise<{ allowMore }>
      notifyPhoneRejected(tabId): Promise<void>
      cancel(tabId): Promise<void>                       // 用户停止
    }
```

每个 tabId 持有独立状态对象；流程结束自动清理。

**长连接语义：**

- `requestCode(tabId)` 是一个「长 promise」：只在 `POLL_OK` 时 resolve，或在 FAILED 终态 reject。中途发生 `SWITCH_NUMBER` 不会让它 reject；状态机切换到新号后继续轮询，原 promise 维持挂起。
- 换号时 bg 主动 push `PHONE_VERIFY_NEW_NUMBER` 给 content，content 收到后清空手机号输入框、重填新号、再次点击提交。`requestCode` 不需要被重新调用。
- 因此 content 端只需调用一次 `requestNumber` + 一次 `requestCode`；剩下的状态切换由 bg 推送事件驱动。

### 7.3 accounts-exporter.js

```js
createAccountsExporter({ chromeStorage, chromeDownloads })
  → {
      appendAccount({ email, password }): Promise<void>
      reexportAll(): Promise<void>     // 侧边栏按钮调用
      listAccounts(): Promise<Array<{email, password, savedAt}>>
    }
```

## 8. 测试要点

按现有 `tests/` 目录风格（jest 类似）：

- `tests/herosms-client.test.js`
  - URL 与参数构造正确（service=oi, country=151）
  - 成功响应解析：`ACCESS_NUMBER:123:+56912345678` → `{id:123, phone:'+56912345678'}`
  - `STATUS_OK:485712` → `{ status:'ok', code:'485712' }`
  - `NO_NUMBERS` / `NO_BALANCE` / `BAD_KEY` / `BANNED:1735689600` → 对应 typed error
  - 网络失败 retry 2 次后抛错

- `tests/phone-verify-flow.test.js`
  - 状态机：每条转移路径独立用例
  - `resendCount = 2` 时第三次点击触发 SWITCH_NUMBER
  - `activationCount = 2` 时进入 FAILED
  - 当前国 `NO_NUMBERS` 自动 fallback 下一国
  - 全部国 `NO_NUMBERS` → FAILED 并释放任何活跃 activation
  - `CANCEL` 在任意状态都正确释放

- `tests/accounts-exporter.test.js`
  - 第一次 append → 单行 data URL
  - 第二次 append → 两行累计，且第二次 `conflictAction:'overwrite'`
  - storage 与 download 内容一致
  - `reexportAll` 与 `appendAccount` 等效

- `tests/integration/signup-with-phone.test.js`
  - 模拟 add_phone_page 出现 → 完整 SMS 走通到 COMPLETE
  - 第二次重发后超时 → 触发换号 → 第二号成功 → 流程完成

- 现有 `add_phone_page` throw 路径的旧用例需更新/删除（搜索 `add_phone_page` 在 tests 下）

## 9. 验收清单

1. 侧边栏填 HeroSMS api_key，`emailGenerator='icloud'`，国家偏好默认 `[智利, 巴西, 英国]`
2. 启动注册 → 控制台依次出现：
   - iCloud 自动选号 / 生成
   - 邮箱验证码自动填入
   - 进入手机号页 → 自动取智利号 → 填入提交
   - 拿到 SMS 验证码 → 填入提交
   - 完成 OAuth → step 11
3. `~/Downloads/accounts.txt` 出现新行：`email----password`
4. 再注册一次 → `accounts.txt` 累计为两行
5. 故意让某号码 2 次重发不到码 → 控制台显示换号 → 第二号完成
6. 用尽 2 个号 + 2 次重发 → 流程终止，`accountRunHistory` 标记失败原因「短信验证失败」
7. 关闭 HeroSMS api_key → 启动注册时立即提示并不消耗 iCloud 别名

## 10. 风险与权衡

| 风险 | 缓解 |
|---|---|
| HeroSMS 号码池受限于热门国家库存 | 国家偏好可在侧边栏调整；默认 3 国循环回退 |
| MouseEvent 补丁可能影响真实点击坐标 | 补丁只作用于 `auth*.openai.com`，影响范围极小；grok-register 已生产使用 |
| `data:` URL 文件覆盖会留多条下载历史 | 侧边栏说明，未来可改用 File System Access API（需扩展权限或托管页） |
| OpenAI 检测 `setInterval` 行为模式 | 本期不处理，仅做 screenX/Y 补丁；后续可加随机延时 |
| HeroSMS 协议变更 | 客户端层独立，集中改一处即可 |

## 11. 后续可选（不在本期）

- 多 api_key 轮换（余额 / 风控分散）
- 失败号码黑名单（避免立刻重取同号）
- 国家级别的费用阈值（maxPrice）
- 反指纹更多维度：UA、Canvas、AudioContext、Navigator.plugins
- `accounts.txt` 改用本地 HTTP server / Native Messaging 真追加
