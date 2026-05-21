(function attachBackgroundStep1(root, factory) {
  root.MultiPageBackgroundStep1 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep1Module() {
  function createStep1Executor(deps = {}) {
    const {
      addLog,
      clearChatGptSessionCookies,
      completeStepFromBackground,
      openSignupEntryTab,
    } = deps;

    async function executeStep1() {
      if (typeof clearChatGptSessionCookies === 'function') {
        await addLog('步骤 1：清理可能存在的 ChatGPT 登录 cookies，避免已登录态卡在聊天页...', 'info');
        const cleanup = await clearChatGptSessionCookies({ logLabel: '步骤 1', silent: true });
        if (cleanup?.supported && cleanup.removed > 0) {
          await addLog(`步骤 1：已删除 ${cleanup.removed} 个 ChatGPT / OpenAI cookies。`, 'ok');
        }
      }
      await addLog('步骤 1：正在打开 ChatGPT 官网...');
      await openSignupEntryTab(1);
      await completeStepFromBackground(1, {});
    }

    return { executeStep1 };
  }

  return { createStep1Executor };
});
