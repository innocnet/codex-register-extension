(function attachBackgroundStep2(root, factory) {
  root.MultiPageBackgroundStep2 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep2Module() {
  function createStep2Executor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      ensureContentScriptReadyOnTab,
      ensureSignupEntryPageReady,
      ensureSignupPostEmailPageReadyInTab,
      getTabId,
      isRetryableContentScriptTransportError,
      isTabAlive,
      phoneVerifyRequestNumber,
      resolveSignupEmailForFlow,
      sendToContentScriptResilient,
      setState,
      SIGNUP_PAGE_INJECT_FILES,
    } = deps;

    const PHONE_SIGNUP_REJECTED_PREFIX = 'PHONE_SIGNUP_REJECTED::';
    const PHONE_SIGNUP_MAX_ATTEMPTS = 5;

    function isPhoneSignupRejected(error) {
      return String(error?.message || error || '').startsWith(PHONE_SIGNUP_REJECTED_PREFIX);
    }

    function isPhoneModeEnabled(state) {
      return Boolean(state?.herosmsApiKey && String(state.herosmsApiKey).trim());
    }

    async function safeGetTabPathname(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.url) return '';
        return new URL(tab.url).pathname || '';
      } catch {
        return '';
      }
    }

    // 兜底：sendToContentScriptResilient 在页面跳转时 content script 来不及 reply 会触发
    // retryable transport error（"did not respond in 30s" / "Receiving end does not exist" 等）。
    // 分两条恢复路径：
    //   A. pathname 已变 → "填表 + 点击继续"已成功触发跳转，构造 navigatedAway 让后续
    //      ensureSignupPostEmailPageReadyInTab 接管确认 landing 页。
    //   B. pathname 未变 → content script 失联但 tab/页面还在原地（注入丢失/被替换/SPA 切回）。
    //      此时尝试重新 inject content script 并重发一次 EXECUTE_STEP，给一次软恢复机会，
    //      避免直接整轮失败。fillSignupPhoneAndContinue 内部对 phone trigger 切换、selectPhoneCountry
    //      等都做了从零开始的检测，重发是幂等的。
    // 与原行为兼容：显式 error 返回（PHONE_SIGNUP_REJECTED::*）走原 step2Result.error 路径；
    // 非 retryable 错误（如业务异常）原样 throw；软恢复也失败时仍 throw 原 err。
    async function dispatchExecuteStep2(signupTabId, preActionPathname, payload, options) {
      const { kind, timeoutMs } = options;
      const logMessage = `步骤 2：官网注册入口正在切换，等待页面恢复后继续输入${kind}...`;
      try {
        return await sendToContentScriptResilient('signup-page', {
          type: 'EXECUTE_STEP',
          step: 2,
          source: 'background',
          payload,
        }, {
          timeoutMs,
          retryDelayMs: 700,
          logMessage,
        });
      } catch (err) {
        const retryable = typeof isRetryableContentScriptTransportError === 'function'
          && isRetryableContentScriptTransportError(err);
        if (!retryable) {
          throw err;
        }

        const currentPathname = await safeGetTabPathname(signupTabId);
        if (currentPathname && preActionPathname && currentPathname !== preActionPathname) {
          await addLog(
            `步骤 2：${kind}已提交后页面已跳转（${preActionPathname} → ${currentPathname}），`
            + `内容脚本响应超时但视为成功，继续后续流程。`,
            'warn'
          );
          return { submitted: true, navigatedAway: true, url: '' };
        }

        // pathname 未变：content script 已失联（"Receiving end does not exist" / 长时间 timeout）
        // 但 tab/页面仍在原地。尝试重新注入 content script 再发一次，给一次软恢复。
        await addLog(
          `步骤 2：${kind} 内容脚本已失联且页面未跳转（${err?.message?.slice(0, 80) || ''}），`
          + `尝试重新注入 content script 后重发一次...`,
          'warn'
        );
        try {
          await ensureContentScriptReadyOnTab('signup-page', signupTabId, {
            inject: SIGNUP_PAGE_INJECT_FILES,
            injectSource: 'signup-page',
            timeoutMs: 20000,
            retryDelayMs: 700,
            logMessage: `步骤 2：${kind} 正在重新注入注册页 content script...`,
          });
          return await sendToContentScriptResilient('signup-page', {
            type: 'EXECUTE_STEP',
            step: 2,
            source: 'background',
            payload,
          }, {
            timeoutMs,
            retryDelayMs: 700,
          });
        } catch (retryErr) {
          await addLog(
            `步骤 2：${kind} 重新注入后重试仍失败：${retryErr?.message?.slice(0, 80) || ''}`,
            'warn'
          );
          throw err;
        }
      }
    }

    async function executeStep2(state) {
      const usePhone = isPhoneModeEnabled(state);

      let signupTabId = await getTabId('signup-page');
      if (!signupTabId || !(await isTabAlive('signup-page'))) {
        await addLog('步骤 2：未发现可用的注册页标签，正在重新打开 ChatGPT 官网...', 'warn');
        signupTabId = (await ensureSignupEntryPageReady(2)).tabId;
      } else {
        await chrome.tabs.update(signupTabId, { active: true });
        await ensureContentScriptReadyOnTab('signup-page', signupTabId, {
          inject: SIGNUP_PAGE_INJECT_FILES,
          injectSource: 'signup-page',
          timeoutMs: 45000,
          retryDelayMs: 900,
          logMessage: '步骤 2：注册入口页内容脚本未就绪，正在等待页面恢复...',
        });
      }

      // 记录"点击继续"前的 pathname，用于在 content script 通信失败时区分
      // "真失败" vs "页面已经跳转所以 content script 没机会 reply"。
      const preActionPathname = await safeGetTabPathname(signupTabId);

      if (usePhone) {
        await addLog('步骤 2：HeroSMS 已配置，使用手机号注册流程...', 'info');
        let phoneResult = await phoneVerifyRequestNumber();
        if (!phoneResult?.ok || !phoneResult?.activation?.phone) {
          throw new Error('HeroSMS 未返回可用手机号，无法继续注册。');
        }

        let phone = phoneResult.activation.phone;
        let phoneCountry = phoneResult.activation.country;
        let step2Result = null;

        for (let attempt = 1; attempt <= PHONE_SIGNUP_MAX_ATTEMPTS; attempt += 1) {
          await setState({ signupPhone: phone, signupPhoneCountry: phoneCountry });
          await addLog(`步骤 2：已获取 HeroSMS 手机号 ${phone}（HeroSMS 国家代码 ${phoneCountry}，第 ${attempt}/${PHONE_SIGNUP_MAX_ATTEMPTS} 个），正在填写注册表单...`);

          const payload = attempt === 1
            ? { phone, phoneCountry }
            : { phone, phoneCountry, retryPhoneEntry: true };
          step2Result = await dispatchExecuteStep2(signupTabId, preActionPathname, payload, {
            kind: '手机号',
            timeoutMs: 30000,
          });

          if (!step2Result?.error || !isPhoneSignupRejected(new Error(step2Result.error))) {
            break;
          }

          const rejectedMsg = String(step2Result.error).slice(PHONE_SIGNUP_REJECTED_PREFIX.length, PHONE_SIGNUP_REJECTED_PREFIX.length + 80);
          const rejectedErr = new Error(`步骤 2：手机号 ${phone} 被注册页拒绝（${rejectedMsg}），将从步骤 1 重新开始。`);
          rejectedErr.smsRestartRequired = true;
          throw rejectedErr;
        }

        if (step2Result?.error) {
          throw new Error(step2Result.error);
        }

        await addLog('步骤 2：手机号已提交，等待进入下一步...');

        const landingResult = await ensureSignupPostEmailPageReadyInTab(signupTabId, 2, {
          skipUrlWait: Boolean(step2Result?.alreadyOnPasswordPage),
        });

        await setState({ signupPhone: phone, signupPhoneCountry: phoneCountry });
        await addLog(`步骤 2 [诊断完成]: 已写入 state.signupPhone=${phone} state.signupPhoneCountry=${phoneCountry}`, 'info');

        await completeStepFromBackground(2, {
          signupPhone: phone,
          signupPhoneCountry: phoneCountry,
          nextSignupState: landingResult?.state || 'password_page',
          nextSignupUrl: landingResult?.url || step2Result?.url || '',
          skippedPasswordStep: landingResult?.state === 'verification_page',
        });
      } else {
        const resolvedEmail = await resolveSignupEmailForFlow(state);

        const step2Result = await dispatchExecuteStep2(signupTabId, preActionPathname, { email: resolvedEmail }, {
          kind: '邮箱',
          timeoutMs: 20000,
        });

        if (step2Result?.error) {
          throw new Error(step2Result.error);
        }

        if (!step2Result?.alreadyOnPasswordPage) {
          await addLog(`步骤 2：邮箱 ${resolvedEmail} 已提交，正在等待页面加载并确认下一步入口...`);
        }

        const landingResult = await ensureSignupPostEmailPageReadyInTab(signupTabId, 2, {
          skipUrlWait: Boolean(step2Result?.alreadyOnPasswordPage),
        });

        await completeStepFromBackground(2, {
          email: resolvedEmail,
          nextSignupState: landingResult?.state || 'password_page',
          nextSignupUrl: landingResult?.url || step2Result?.url || '',
          skippedPasswordStep: landingResult?.state === 'verification_page',
        });
      }
    }

    return { executeStep2 };
  }

  return { createStep2Executor };
});
