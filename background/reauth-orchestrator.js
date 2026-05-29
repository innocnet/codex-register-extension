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

    return { runForAccount };
  }

  return { createReauthOrchestrator, REAUTH_STEPS };
});
