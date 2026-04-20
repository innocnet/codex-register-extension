# 2026-04-16 Architecture Refactor Plan

## 目标

在不破坏现有 1~9 步自动化流程、消息流、状态机和测试保护面的前提下，逐步拆分当前超大的主文件，降低后续开发和排障成本。

## 当前事实

- 这是一个无构建步骤的 Manifest V3 扩展。
- `background.js` 是 classic service worker，当前依赖 `importScripts(...)`。
- `sidepanel/sidepanel.html` 通过多个 `<script>` 直接加载脚本。
- 运行态核心链路依赖：
  - `chrome.storage.session` 保存流程态
  - `chrome.storage.local` 保存配置态
  - `chrome.runtime.sendMessage` 贯穿 sidepanel / background / content scripts
  - `chrome.tabs` / `chrome.webNavigation` / `chrome.debugger` 支撑步骤执行
- 测试不仅验证行为，还会直接从 `background.js` / `sidepanel.js` / `content/*.js` 按函数名提取源码执行。

## 已确认基线

- `bun test` 当前基线：`84 pass / 0 fail`
- 关键大文件规模：
  - `background.js`: 7481 行
  - `sidepanel/sidepanel.js`: 4531 行
  - `content/signup-page.js`: 1969 行

## 当前结构压力点

### `background.js`

- 状态/配置、邮箱提供者、Tab 管理、消息路由、自动运行状态机、步骤 1~9 全部集中在单文件。
- 文件内同时存在：
  - 纯函数
  - 网络请求
  - 存储读写
  - 浏览器 API 调度
  - 步骤业务逻辑
- 风险最高的区域不是“代码长”，而是“跨区域共享状态太多”。

### `sidepanel/sidepanel.js`

- 同时承担：
  - DOM 查询
  - 状态同步
  - 配置读写
  - 多个 provider 管理器
  - 按钮事件绑定
  - background 广播处理
- Hotmail / LuckMail / iCloud 三块都已经是天然的 feature slice，但仍堆在一个文件里。

## 重构硬约束

### 约束 1：先拆“强内聚功能块”，后拆“流程主干”

优先拆：

- Hotmail 账号池 UI
- LuckMail 管理 UI
- iCloud 别名管理 UI
- CPA / SUB2API 面板桥接层

暂缓拆：

- `executeStep1~9`
- `autoRunLoop`
- `handleMessage`
- `resolveVerificationStep`

原因：这些主干函数既是运行核心，也是当前测试抽取最密集的区域。

### 约束 2：第一阶段尽量不改变被测试函数的“定义位置”

由于现有测试会直接从源文件提取函数源码，第一阶段要避免大规模把被测函数从原文件移走。

### 约束 3：运行边界不能变

以下运行边界必须保持：

- `background.js` 继续是 service worker 入口
- `sidepanel/sidepanel.html` 继续是 sidepanel 入口
- content script 注入方式不变
- 所有 runtime message type 不变
- storage key 不变

## 目标结构

### 背景层目标

```txt
background.js
background/
  state/
    settings.js
    session-state.js
  runtime/
    tabs.js
    command-queue.js
    logging.js
    message-router.js
  providers/
    hotmail.js
    luckmail.js
    icloud.js
    generated-email.js
  steps/
    step1.js
    step2.js
    step3.js
    verification.js
    step5.js
    step6.js
    step7.js
    step8.js
    step9.js
  auto-run/
    scheduler.js
    loop.js
```

### Sidepanel 层目标

```txt
sidepanel/sidepanel.js
sidepanel/
  hotmail-manager.js
  luckmail-manager.js
  icloud-manager.js
  auto-run-ui.js
  runtime-listeners.js
  update-service.js
```

## 分阶段执行顺序

### Phase 1

先拆 `sidepanel` 的强内聚管理区块。

- 先拆 Hotmail manager
- 再拆 iCloud manager
- 再拆 LuckMail manager

原因：

- 不触碰主流程状态机
- 风险主要局限在 sidepanel UI
- 可以验证“多脚本 + 工厂上下文”的拆分模式

### Phase 2

拆 `background.js` 中和主流程相对解耦的桥接层。

- CPA / SUB2API OAuth 桥接
- 邮箱 provider 的 API 访问层
- Cloudflare / Duck / iCloud 生成邮箱层

### Phase 3

拆 `background.js` 中的运行时基础设施。

- tab registry
- command queue
- logging
- storage helpers

### Phase 4

最后拆步骤执行器与 auto-run 主循环。

- `executeStep1~9`
- `resolveVerificationStep`
- `autoRunLoop`

## 第一阶段落地策略

本轮先做：

1. 新增 `sidepanel/hotmail-manager.js`
2. 让 `sidepanel.js` 通过工厂方式接入 Hotmail manager
3. 不改变 runtime message type
4. 不改变 Hotmail 区块的 UI 行为
5. 跑现有测试确认基线仍然成立

## 验收标准

- `bun test` 继续全绿
- sidepanel Hotmail 区块行为无回归
- `sidepanel.js` 不再直接承载 Hotmail 账号池的大段渲染和事件逻辑
- 后续可以按同样模式继续拆 iCloud / LuckMail
