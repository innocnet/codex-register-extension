(function attachBackgroundStep4(root, factory) {
  root.MultiPageBackgroundStep4 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep4Module() {
  function createStep4Executor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      confirmCustomVerificationStepBypass,
      getMailConfig,
      getTabId,
      HOTMAIL_PROVIDER,
      isTabAlive,
      LUCKMAIL_PROVIDER,
      CLOUDFLARE_TEMP_EMAIL_PROVIDER,
      phoneVerifyPollForCode,
      phoneVerifyResendCurrentNumber,
      resolveVerificationStep,
      reuseOrCreateTab,
      sendToContentScriptResilient,
      shouldUseCustomRegistrationEmail,
      STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS,
      throwIfStopped,
    } = deps;

    async function executeStep4SmsSmsMode(state) {
      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('认证页面标签页已关闭，无法继续步骤 4（手机号验证码模式）。');
      }
      await chrome.tabs.update(signupTabId, { active: true });
      throwIfStopped();

      const pollIntervalMs = Number(state.signupVerificationPollIntervalMs) || 5000;
      const pollMaxAttempts = Number(state.signupVerificationPollMaxAttempts) || 12;
      const roundTimeoutSec = Math.round((pollIntervalMs * pollMaxAttempts) / 1000);
      const maxResendAttempts = Number(state.herosmsMaxResendAttempts) || Number(state.verificationResendCount) || 2;
      const SMS_POLL_MAX_ROUNDS = maxResendAttempts + 1;

      await addLog(`步骤 4：手机号注册模式，正在等待 HeroSMS 短信验证码（每轮最多等 ${roundTimeoutSec}s，共 ${SMS_POLL_MAX_ROUNDS} 轮）...`);

      for (let attempt = 0; attempt < SMS_POLL_MAX_ROUNDS; attempt += 1) {
        throwIfStopped();
        await addLog(`步骤 4：第 ${attempt + 1}/${SMS_POLL_MAX_ROUNDS} 轮轮询中，预计等待约 ${roundTimeoutSec}s...`);
        const pollResult = await phoneVerifyPollForCode();

        if (pollResult?.ok && pollResult?.code) {
          const code = String(pollResult.code);
          await addLog('步骤 4：已收到短信验证码，正在填写...', 'ok');
          const fillResult = await sendToContentScriptResilient('signup-page', {
            type: 'FILL_CODE',
            step: 4,
            source: 'background',
            payload: { code },
          }, {
            timeoutMs: 15000,
            retryDelayMs: 700,
            logMessage: '步骤 4：认证页正在切换，等待恢复后填写验证码...',
          });
          if (fillResult?.error) {
            throw new Error(fillResult.error);
          }
          await completeStepFromBackground(4, { signupPhone: state.signupPhone });
          return;
        }

        // Timeout or requiresNewNumber — try resend first
        const pollReason = pollResult?.reason || '未知';
        await addLog(`步骤 4：验证码未收到（${pollReason}），尝试重发短信...`, 'warn');

        const resendResult = await phoneVerifyResendCurrentNumber();

        if (resendResult?.resent) {
          const resendCount = resendResult.resendCount || 1;
          const maxResendAttempts = resendResult.maxResendAttempts || 2;
          await addLog(`步骤 4：已向 HeroSMS 请求重发（第 ${resendCount}/${maxResendAttempts} 次），正在检查页面...`);

          const checkResult = await sendToContentScriptResilient('signup-page', {
            type: 'STEP4_PHONE_RESEND_CHECK',
            step: 4,
            source: 'background',
          }, {
            timeoutMs: 15000,
            retryDelayMs: 700,
            logMessage: '步骤 4：等待验证码页面响应重发检查...',
          });

          if (!checkResult?.phoneError) {
            await addLog('步骤 4：页面未检测到手机号异常，继续等待验证码...');
            continue;
          }

          // Page confirms SMS cannot be sent to this number — throw so background restarts from step 1
          await addLog(`步骤 4：页面检测到手机号无法接收短信（${String(checkResult.phoneError).slice(0, 60)}），将从步骤 1 重新注册...`, 'warn');
          const phoneErr = new Error(`步骤 4：手机号无法接收短信，流程将从步骤 1 重新开始。原因：${String(checkResult.phoneError).slice(0, 80)}`);
          phoneErr.smsRestartRequired = true;
          throw phoneErr;
        } else {
          const reason = resendResult?.reason || '重发失败';
          await addLog(`步骤 4：${reason === 'RESEND_LIMIT' ? '重发次数已用完' : '重发失败'}，将从步骤 1 重新注册...`, 'warn');
          const resendLimitErr = new Error(`步骤 4：短信重发次数耗尽（${reason}），流程将从步骤 1 重新开始。`);
          resendLimitErr.smsRestartRequired = true;
          throw resendLimitErr;
        }
      }

      const pollExhaustedErr = new Error('步骤 4：短信验证码多轮等待后仍未收到，流程中止。');
      pollExhaustedErr.smsRestartRequired = true;
      throw pollExhaustedErr;
    }

    async function executeStep4(state) {
      if (state?.signupPhone) {
        return executeStep4SmsSmsMode(state);
      }

      const mail = getMailConfig(state);
      if (mail.error) throw new Error(mail.error);
      const stepStartedAt = Date.now();
      const verificationSessionKey = `4:${stepStartedAt}`;
      const signupTabId = await getTabId('signup-page');
      if (!signupTabId) {
        throw new Error('认证页面标签页已关闭，无法继续步骤 4。');
      }

      await chrome.tabs.update(signupTabId, { active: true });
      throwIfStopped();
      await addLog('步骤 4：正在确认注册验证码页面是否就绪，必要时自动恢复密码页超时报错...');
      const prepareResult = await sendToContentScriptResilient(
        'signup-page',
        {
          type: 'PREPARE_SIGNUP_VERIFICATION',
          step: 4,
          source: 'background',
          payload: {
            password: state.password || state.customPassword || '',
            prepareSource: 'step4_execute',
            prepareLogLabel: '步骤 4 执行',
          },
        },
        {
          timeoutMs: 30000,
          retryDelayMs: 700,
          logMessage: '步骤 4：认证页正在切换，等待页面重新就绪后继续检测...',
        }
      );

      if (prepareResult && prepareResult.error) {
        throw new Error(prepareResult.error);
      }
      if (prepareResult?.alreadyVerified) {
        await completeStepFromBackground(4, {});
        return;
      }

      if (shouldUseCustomRegistrationEmail(state)) {
        await confirmCustomVerificationStepBypass(4);
        return;
      }

      throwIfStopped();
      if (mail.provider === HOTMAIL_PROVIDER || mail.provider === LUCKMAIL_PROVIDER || mail.provider === CLOUDFLARE_TEMP_EMAIL_PROVIDER) {
        await addLog(`步骤 4：正在通过 ${mail.label} 轮询验证码...`);
      } else {
        await addLog(`步骤 4：正在打开${mail.label}...`);

        const alive = await isTabAlive(mail.source);
        if (alive) {
          if (mail.navigateOnReuse) {
            await reuseOrCreateTab(mail.source, mail.url, {
              inject: mail.inject,
              injectSource: mail.injectSource,
            });
          } else {
            const tabId = await getTabId(mail.source);
            await chrome.tabs.update(tabId, { active: true });
          }
        } else {
          await reuseOrCreateTab(mail.source, mail.url, {
            inject: mail.inject,
            injectSource: mail.injectSource,
          });
        }
      }

      await resolveVerificationStep(4, state, mail, {
        filterAfterTimestamp: stepStartedAt,
        sessionKey: verificationSessionKey,
        stepEnteredAt: stepStartedAt,
        disableTimeBudgetCap: mail.provider === '2925',
        requestFreshCodeFirst: mail.provider === HOTMAIL_PROVIDER ? false : true,
        resendIntervalMs: (mail.provider === HOTMAIL_PROVIDER || mail.provider === '2925')
          ? 0
          : STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS,
      });
    }

    return { executeStep4 };
  }

  return { createStep4Executor };
});
