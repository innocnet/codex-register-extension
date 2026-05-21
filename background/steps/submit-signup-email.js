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
          step2Result = await sendToContentScriptResilient('signup-page', {
            type: 'EXECUTE_STEP',
            step: 2,
            source: 'background',
            payload,
          }, {
            timeoutMs: 30000,
            retryDelayMs: 700,
            logMessage: '步骤 2：官网注册入口正在切换，等待页面恢复后继续输入手机号...',
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

        const step2Result = await sendToContentScriptResilient('signup-page', {
          type: 'EXECUTE_STEP',
          step: 2,
          source: 'background',
          payload: { email: resolvedEmail },
        }, {
          timeoutMs: 20000,
          retryDelayMs: 700,
          logMessage: '步骤 2：官网注册入口正在切换，等待页面恢复后继续输入邮箱...',
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
