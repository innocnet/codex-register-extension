// content/signup-page.js — Content script for ChatGPT signup entry + OpenAI auth pages
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com
// Dynamically injected on: chatgpt.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

const SIGNUP_PAGE_LISTENER_SENTINEL = 'data-multipage-signup-page-listener';

if (document.documentElement.getAttribute(SIGNUP_PAGE_LISTENER_SENTINEL) !== '1') {
  document.documentElement.setAttribute(SIGNUP_PAGE_LISTENER_SENTINEL, '1');

  // Listen for commands from Background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message.type === 'EXECUTE_STEP'
      || message.type === 'FILL_CODE'
      || message.type === 'STEP8_FIND_AND_CLICK'
      || message.type === 'STEP8_GET_STATE'
      || message.type === 'STEP8_TRIGGER_CONTINUE'
      || message.type === 'GET_LOGIN_AUTH_STATE'
      || message.type === 'PREPARE_SIGNUP_VERIFICATION'
      || message.type === 'RECOVER_AUTH_RETRY_PAGE'
      || message.type === 'RESEND_VERIFICATION_CODE'
      || message.type === 'ENSURE_SIGNUP_ENTRY_READY'
      || message.type === 'ENSURE_SIGNUP_PASSWORD_PAGE_READY'
      || message.type === 'STEP4_PHONE_RESEND_CHECK'
    ) {
      resetStopState();
      handleCommand(message).then((result) => {
        sendResponse({ ok: true, ...(result || {}) });
      }).catch(err => {
        if (isStopError(err)) {
          if (message.step) {
            log(`步骤 ${message.step || 8}：已被用户停止。`, 'warn');
          }
          sendResponse({ stopped: true, error: err.message });
          return;
        }

        if (message.type === 'STEP8_FIND_AND_CLICK') {
          log(`步骤 9：${err.message}`, 'error');
          sendResponse({ error: err.message });
          return;
        }

        if (message.step) {
          reportError(message.step, err.message);
        }
        sendResponse({ error: err.message });
      });
      return true;
    }
  });
} else {
  console.log('[MultiPage:signup-page] 消息监听已存在，跳过重复注册');
}

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister(message.payload);
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 7: return await step6_login(message.payload);
        case 9: return await step8_findAndClick();
        default: throw new Error(`signup-page.js 不处理步骤 ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'GET_LOGIN_AUTH_STATE':
      return serializeLoginAuthState(inspectLoginAuthState());
    case 'PREPARE_SIGNUP_VERIFICATION':
      return await prepareSignupVerificationFlow(message.payload);
    case 'RECOVER_AUTH_RETRY_PAGE':
      return await recoverCurrentAuthRetryPage(message.payload);
    case 'RESEND_VERIFICATION_CODE':
      return await resendVerificationCode(message.step);
    case 'ENSURE_SIGNUP_ENTRY_READY':
      return await ensureSignupEntryReady();
    case 'ENSURE_SIGNUP_PASSWORD_PAGE_READY':
      return await ensureSignupPasswordPageReady();
    case 'STEP4_PHONE_RESEND_CHECK':
      return await step4PhoneResendAndCheck();
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
    case 'STEP8_GET_STATE':
      return getStep8State();
    case 'STEP8_TRIGGER_CONTINUE':
      return await step8_triggerContinue(message.payload);
  }
}

const VERIFICATION_CODE_INPUT_SELECTOR = [
  'input[name="code"]',
  'input[name="otp"]',
  'input[autocomplete="one-time-code"]',
  'input[type="text"][maxlength="6"]',
  'input[type="tel"][maxlength="6"]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[inputmode="numeric"]',
].join(', ');

const ONE_TIME_CODE_LOGIN_PATTERN = /使用一次性验证码登录|改用(?:一次性)?验证码(?:登录)?|使用验证码登录|一次性验证码|验证码登录|one[-\s]*time\s*(?:passcode|password|code)|use\s+(?:a\s+)?one[-\s]*time\s*(?:passcode|password|code)(?:\s+instead)?|use\s+(?:a\s+)?code(?:\s+instead)?|sign\s+in\s+with\s+(?:email|code)|email\s+(?:me\s+)?(?:a\s+)?code/i;

const RESEND_VERIFICATION_CODE_PATTERN = /重新发送(?:验证码)?|再次发送(?:验证码)?|重发(?:验证码)?|未收到(?:验证码|邮件)|resend(?:\s+code)?|send\s+(?:a\s+)?new\s+code|send\s+(?:it\s+)?again|request\s+(?:a\s+)?new\s+code|didn'?t\s+receive/i;

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.width > 0
    && rect.height > 0;
}

function getVerificationCodeTarget() {
  const codeInput = document.querySelector(VERIFICATION_CODE_INPUT_SELECTOR);
  if (codeInput && isVisibleElement(codeInput)) {
    return { type: 'single', element: codeInput };
  }

  const singleInputs = Array.from(document.querySelectorAll('input[maxlength="1"]'))
    .filter(isVisibleElement);
  if (singleInputs.length >= 6) {
    return { type: 'split', elements: singleInputs };
  }

  return null;
}

function getActionText(el) {
  return [
    el?.textContent,
    el?.value,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isActionEnabled(el) {
  return Boolean(el)
    && !el.disabled
    && el.getAttribute('aria-disabled') !== 'true';
}

function findOneTimeCodeLoginTrigger() {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );

  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const text = [
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text && ONE_TIME_CODE_LOGIN_PATTERN.test(text)) {
      return el;
    }
  }

  return null;
}

function findResendVerificationCodeTrigger({ allowDisabled = false } = {}) {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );

  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    if (!allowDisabled && !isActionEnabled(el)) continue;

    const text = getActionText(el);
    if (text && RESEND_VERIFICATION_CODE_PATTERN.test(text)) {
      return el;
    }
  }

  return null;
}

function isEmailVerificationPage() {
  return /\/email-verification(?:[/?#]|$)/i.test(location.pathname || '');
}

async function resendVerificationCode(step, timeout = 45000) {
  if (step === 8) {
    await waitForLoginVerificationPageReady();
  }

  const start = Date.now();
  let action = null;
  let loggedWaiting = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();

    // Check for 405 error page and recover by clicking "Try again"
    if (is405MethodNotAllowedPage()) {
      await handle405ResendError(step, timeout - (Date.now() - start));
      // After recovery, loop back to find the resend button again
      loggedWaiting = false;
      continue;
    }

    action = findResendVerificationCodeTrigger({ allowDisabled: true });

    if (action && isActionEnabled(action)) {
      log(`步骤 ${step}：重新发送验证码按钮已可用。`);
      await humanPause(350, 900);
      simulateClick(action);
      await sleep(1200);

      // After clicking resend, check if 405 error appeared
      if (is405MethodNotAllowedPage()) {
        log(`步骤 ${step}：点击重新发送后出现 405 错误，正在恢复...`, 'warn');
        await handle405ResendError(step, timeout - (Date.now() - start));
        loggedWaiting = false;
        continue;
      }

      return {
        resent: true,
        buttonText: getActionText(action),
      };
    }

    if (action && !loggedWaiting) {
      loggedWaiting = true;
      log(`步骤 ${step}：正在等待重新发送验证码按钮变为可点击...`);
    }

    await sleep(250);
  }

  throw new Error('无法点击重新发送验证码按钮。URL: ' + location.href);
}

function is405MethodNotAllowedPage() {
  const pageText = document.body?.textContent || '';
  return AUTH_ROUTE_ERROR_PATTERN.test(pageText);
}

async function handle405ResendError(step, remainingTimeout = 30000) {
  await recoverCurrentAuthRetryPage({
    logLabel: `步骤 ${step}：检测到 405 错误页面，正在点击“重试”恢复`,
    pathPatterns: [],
    step,
    timeoutMs: Math.max(1000, remainingTimeout),
  });
  log(`步骤 ${step}：405 错误已恢复，页面已返回验证码页面。`);
}

// ============================================================
// Signup Entry Helpers
// ============================================================

const SIGNUP_ENTRY_TRIGGER_PATTERN = /免费注册|立即注册|注册|sign\s*up|register|create\s*account|create\s+account/i;
const SIGNUP_EMAIL_INPUT_SELECTOR = 'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i]';

function getSignupEmailInput() {
  const input = document.querySelector(SIGNUP_EMAIL_INPUT_SELECTOR);
  return input && isVisibleElement(input) ? input : null;
}

function getSignupEmailContinueButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    return /continue|next|submit|继续|下一步/i.test(getActionText(el));
  }) || null;
}

function findSignupEntryTrigger() {
  const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    return SIGNUP_ENTRY_TRIGGER_PATTERN.test(getActionText(el));
  }) || null;
}

function getSignupPasswordDisplayedEmail() {
  const text = (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
  return matches?.[0] ? String(matches[0]).trim().toLowerCase() : '';
}

function inspectSignupEntryState() {
  const passwordInput = getSignupPasswordInput();
  if (isSignupPasswordPage() && passwordInput) {
    return {
      state: 'password_page',
      passwordInput,
      submitButton: getSignupPasswordSubmitButton({ allowDisabled: true }),
      displayedEmail: getSignupPasswordDisplayedEmail(),
      url: location.href,
    };
  }

  const emailInput = getSignupEmailInput();
  if (emailInput) {
    return {
      state: 'email_entry',
      emailInput,
      continueButton: getSignupEmailContinueButton({ allowDisabled: true }),
      url: location.href,
    };
  }

  const signupTrigger = findSignupEntryTrigger();
  if (signupTrigger) {
    return {
      state: 'entry_home',
      signupTrigger,
      url: location.href,
    };
  }

  return {
    state: 'unknown',
    url: location.href,
  };
}

function getSignupEntryDiagnostics() {
  const actionCandidates = document.querySelectorAll(
    'a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  const allActions = Array.from(actionCandidates).map((el) => {
    const rect = typeof el?.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : null;
    const text = getActionText(el);
    return {
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      text: text.slice(0, 80),
      visible: isVisibleElement(el),
      enabled: isActionEnabled(el),
      rect: rect
        ? {
            width: Math.round(rect.width || 0),
            height: Math.round(rect.height || 0),
          }
        : null,
    };
  });
  const visibleActions = Array.from(actionCandidates)
    .filter(isVisibleElement)
    .slice(0, 12)
    .map((el) => ({
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      text: getActionText(el).slice(0, 80),
      enabled: isActionEnabled(el),
    }))
    .filter((item) => item.text);
  const signupLikeActions = allActions
    .filter((item) => item.text && SIGNUP_ENTRY_TRIGGER_PATTERN.test(item.text))
    .slice(0, 12);

  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState || '',
    hasEmailInput: Boolean(getSignupEmailInput()),
    hasPasswordInput: Boolean(getSignupPasswordInput()),
    bodyContainsSignupText: SIGNUP_ENTRY_TRIGGER_PATTERN.test(getPageTextSnapshot()),
    signupLikeActions,
    visibleActions,
    bodyTextPreview: getPageTextSnapshot().slice(0, 240),
  };
}

async function waitForSignupEntryState(options = {}) {
  const {
    timeout = 15000,
    autoOpenEntry = false,
  } = options;
  await waitForCloudflareTurnstileResolution();
  const start = Date.now();
  let lastTriggerClickAt = 0;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isCloudflareTurnstilePage()) {
      await waitForCloudflareTurnstileResolution();
    }
    const snapshot = inspectSignupEntryState();

    if (snapshot.state === 'password_page' || snapshot.state === 'email_entry') {
      return snapshot;
    }

    if (snapshot.state === 'entry_home') {
      if (!autoOpenEntry) {
        return snapshot;
      }

      if (Date.now() - lastTriggerClickAt >= 1500) {
        lastTriggerClickAt = Date.now();
        log('步骤 2：正在点击官网注册入口...');
        await humanPause(350, 900);
        simulateClick(snapshot.signupTrigger);
      }
    }

    await sleep(250);
  }

  return inspectSignupEntryState();
}

async function ensureSignupEntryReady(timeout = 15000) {
  const snapshot = await waitForSignupEntryState({ timeout, autoOpenEntry: false });
  if (snapshot.state === 'entry_home' || snapshot.state === 'email_entry' || snapshot.state === 'password_page') {
    return {
      ready: true,
      state: snapshot.state,
      url: snapshot.url || location.href,
    };
  }

  log(`注册入口识别失败，诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
  throw new Error('当前页面没有可用的注册入口，也不在邮箱/密码页。URL: ' + location.href);
}

async function ensureSignupPasswordPageReady(timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const passwordInput = getSignupPasswordInput();
    if (isSignupPasswordPage() && passwordInput) {
      return {
        ready: true,
        state: 'password_page',
        url: location.href,
      };
    }
    await sleep(200);
  }

  throw new Error('等待进入密码页超时。URL: ' + location.href);
}

async function fillSignupEmailAndContinue(email, step) {
  if (!email) throw new Error(`未提供邮箱地址，步骤 ${step} 无法继续。`);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const snapshot = await waitForSignupEntryState({
    timeout: 20000,
    autoOpenEntry: true,
  });

  if (snapshot.state === 'password_page') {
    if (snapshot.displayedEmail && snapshot.displayedEmail !== normalizedEmail) {
      throw new Error(`步骤 ${step}：当前密码页邮箱为 ${snapshot.displayedEmail}，与目标邮箱 ${email} 不一致，请先回到步骤 1 重新开始。`);
    }
    log(`步骤 ${step}：当前已在密码页，无需重复提交邮箱。`);
    return {
      alreadyOnPasswordPage: true,
      url: snapshot.url || location.href,
    };
  }

  if (snapshot.state !== 'email_entry' || !snapshot.emailInput) {
    throw new Error(`步骤 ${step}：未找到可用的邮箱输入入口。URL: ${location.href}`);
  }

  log(`步骤 ${step}：正在填写邮箱：${email}`);
  await humanPause(500, 1400);
  fillInput(snapshot.emailInput, email);
  log(`步骤 ${step}：邮箱已填写`);

  const continueButton = snapshot.continueButton || getSignupEmailContinueButton({ allowDisabled: true });
  if (!continueButton || !isActionEnabled(continueButton)) {
    throw new Error(`步骤 ${step}：未找到可点击的“继续”按钮。URL: ${location.href}`);
  }

  log(`步骤 ${step}：邮箱已准备提交，正在前往密码页...`);
  window.setTimeout(() => {
    try {
      throwIfStopped();
      simulateClick(continueButton);
    } catch (error) {
      if (!isStopError(error)) {
        console.error('[MultiPage:signup-page] deferred signup email submit failed:', error?.message || error);
      }
    }
  }, 120);

  return {
    submitted: true,
    email,
    url: location.href,
  };
}

// ============================================================
// Step 2: Click Register, fill email, then continue to password page
// ============================================================

async function step4PhoneResendAndCheck() {
  const resendBtn = findResendVerificationCodeTrigger({ allowDisabled: false });
  if (resendBtn) {
    log('步骤 4：找到页面重发按钮，正在点击...', 'info');
    await humanPause(350, 800);
    simulateClick(resendBtn);
    await sleep(3000);
  } else {
    log('步骤 4：未找到可用的页面重发按钮。', 'warn');
  }
  const phoneError = getPhonePageErrorText();
  return { ok: true, phoneError: phoneError || null };
}

async function fillSignupPhoneAndContinue(phone, step, countryCode = null, retryPhoneEntry = false) {
  if (!phone) throw new Error(`未提供手机号，步骤 ${step} 无法继续。`);

  const formattedPhone = formatHeroSmsPhoneNumber(phone, countryCode);

  // When retrying after number replacement, navigate back to phone entry form.
  if (retryPhoneEntry && !getSignupPhoneInput() && !findPhoneSignupTrigger()) {
    const onLoginPage = /\/log-in\/password(?:[/?#]|$)/i.test(location.pathname);
    log(`步骤 ${step}：当前不在手机号录入页面${onLoginPage ? '（登录密码页）' : ''}，尝试返回...`);
    const changeAction = findChangePhoneNumberAction();
    if (changeAction) {
      log(`步骤 ${step}：找到"${getActionText(changeAction).slice(0, 12)}"按钮，正在点击...`);
      await humanPause(300, 700);
      simulateClick(changeAction);
      await sleep(1500);
    } else if (onLoginPage) {
      // No navigation button on login page — reject so background can restart signup flow
      log(`步骤 ${step}：登录密码页未找到导航按钮，需要重新启动注册流程...`, 'warn');
      throw new Error(`${PHONE_SIGNUP_REJECTED_PREFIX}phone_already_registered`);
    } else {
      log(`步骤 ${step}：未找到"更换号码"按钮，等待背景页导航完成...`);
      await sleep(1000);
    }
  }

  // Fast rejection on first attempt (not retry): immediate bail-out without 20s wait
  if (!retryPhoneEntry && /\/log-in\/password(?:[/?#]|$)/i.test(location.pathname)) {
    log(`步骤 ${step}：当前已在登录密码页（手机号已被注册），准备更换号码...`, 'warn');
    throw new Error(`${PHONE_SIGNUP_REJECTED_PREFIX}phone_already_registered`);
  }

  // If phone input (or trigger) is already visible, skip the entry-state wait entirely.
  // waitForSignupEntryState is designed for email-based entry and would spin 20 s returning
  // "unknown" on a phone-entry page, wasting time and risking a wrong autoOpenEntry click.
  const phoneAlreadyReady = Boolean(getSignupPhoneInput() || findPhoneSignupTrigger());
  const snapshot = phoneAlreadyReady
    ? { state: 'phone_entry', url: location.href }
    : await waitForSignupEntryState({ timeout: 20000, autoOpenEntry: true });

  if (snapshot.state === 'password_page') {
    log(`步骤 ${step}：当前已在密码页，手机号已填写完成。`);
    return { alreadyOnPasswordPage: true, url: snapshot.url || location.href };
  }

  let phoneInput = getSignupPhoneInput();
  if (!phoneInput) {
    const phoneTrigger = findPhoneSignupTrigger();
    if (phoneTrigger) {
      log(`步骤 ${step}：找到手机号注册入口"${getActionText(phoneTrigger).slice(0, 30)}"，正在切换...`);
      await humanPause(400, 900);
      simulateClick(phoneTrigger);
      const triggerWaitStart = Date.now();
      while (Date.now() - triggerWaitStart < 5000) {
        throwIfStopped();
        phoneInput = getSignupPhoneInput();
        if (phoneInput) break;
        await sleep(200);
      }
    }
  }

  if (!phoneInput) {
    throw new Error(`步骤 ${step}：未找到手机号输入框，页面上也未找到"使用电话号码"入口。URL: ${location.href}`);
  }

  // Select country before filling phone number
  if (countryCode) {
    log(`步骤 ${step}：正在选择国家（HeroSMS 代码 ${countryCode}）...`);
    const countryResult = await selectPhoneCountry(countryCode);
    if (countryResult.selected) {
      log(`步骤 ${step}：国家已选择：${countryResult.country}`);
      await sleep(300);
    }
  }

  log(`步骤 ${step}：正在填写手机号：${formattedPhone}`);
  await humanPause(500, 1200);
  fillInput(phoneInput, formattedPhone);
  log(`步骤 ${step}：手机号已填写`);

  const continueButton = getSignupEmailContinueButton({ allowDisabled: true });
  if (!continueButton || !isActionEnabled(continueButton)) {
    throw new Error(`步骤 ${step}：未找到可点击的"继续"按钮。URL: ${location.href}`);
  }

  log(`步骤 ${step}：手机号已准备提交...`);
  simulateClick(continueButton);

  const rejectStart = Date.now();
  while (Date.now() - rejectStart < 5000) {
    throwIfStopped();
    const errorText = getPhonePageErrorText();
    if (errorText) {
      log(`步骤 ${step}：注册手机号被拒绝（${errorText.slice(0, 80)}），准备更换号码...`, 'warn');
      throw new Error(`${PHONE_SIGNUP_REJECTED_PREFIX}${errorText}`);
    }
    // Detect redirect to login page — the phone number is already registered
    if (/\/log-in\/password(?:[/?#]|$)/i.test(location.pathname)) {
      log(`步骤 ${step}：手机号已被注册（页面已跳转至登录页），准备更换号码...`, 'warn');
      throw new Error(`${PHONE_SIGNUP_REJECTED_PREFIX}phone_already_registered`);
    }
    if (!getSignupPhoneInput() && !findPhoneSignupTrigger()) {
      break;
    }
    await sleep(300);
  }

  return { submitted: true, phone: formattedPhone, url: location.href };
}

async function step2_clickRegister(payload = {}) {
  const { email, phone, phoneCountry, retryPhoneEntry } = payload;
  if (phone) {
    if (retryPhoneEntry) {
      log('步骤 2：更换手机号后重新填写手机号...');
    }
    return fillSignupPhoneAndContinue(phone, 2, phoneCountry, retryPhoneEntry);
  }
  return fillSignupEmailAndContinue(email, 2);
}

// ============================================================
// Step 3: Fill Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email, password } = payload;
  if (!password) throw new Error('未提供密码，步骤 3 需要可用密码。');
  const normalizedEmail = String(email || '').trim().toLowerCase();

  let snapshot = inspectSignupEntryState();
  if (snapshot.state === 'entry_home') {
    throw new Error('当前仍停留在 ChatGPT 官网首页，请先完成步骤 2。');
  }

  if (snapshot.state === 'email_entry') {
    const transition = await fillSignupEmailAndContinue(email, 3);
    if (!transition.alreadyOnPasswordPage) {
      await sleep(1200);
      await ensureSignupPasswordPageReady();
    }
    snapshot = inspectSignupEntryState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    await ensureSignupPasswordPageReady();
    snapshot = inspectSignupEntryState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    throw new Error('在密码页未找到密码输入框。URL: ' + location.href);
  }
  if (normalizedEmail && snapshot.displayedEmail && snapshot.displayedEmail !== normalizedEmail) {
    throw new Error(`当前密码页邮箱为 ${snapshot.displayedEmail}，与目标邮箱 ${email} 不一致，请先回到步骤 1 重新开始。`);
  }

  await humanPause(600, 1500);
  fillInput(snapshot.passwordInput, password);
  log('步骤 3：密码已填写');

  const submitBtn = snapshot.submitButton
    || getSignupPasswordSubmitButton({ allowDisabled: true })
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  const signupVerificationRequestedAt = submitBtn ? Date.now() : null;
  const completionPayload = {
    email,
    signupVerificationRequestedAt,
    deferredSubmit: Boolean(submitBtn),
  };
  reportComplete(3, completionPayload);

  // Submit the form (page will navigate away after this)
  await sleep(500);
  if (submitBtn) {
    window.setTimeout(async () => {
      try {
        throwIfStopped();
        await sleep(500);
        await humanPause(500, 1300);
        simulateClick(submitBtn);
        log('步骤 3：表单已提交');
      } catch (error) {
        if (!isStopError(error)) {
          console.error('[MultiPage:signup-page] deferred step 3 submit failed:', error?.message || error);
        }
      }
    }, 120);
  }

  return completionPayload;
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

const INVALID_VERIFICATION_CODE_PATTERN = /代码不正确|验证码不正确|验证码错误|code\s+(?:is\s+)?incorrect|invalid\s+code|incorrect\s+code|try\s+again/i;
const VERIFICATION_PAGE_PATTERN = /检查您的收件箱|输入我们刚刚向|重新发送电子邮件|重新发送验证码|代码不正确|email\s+verification|check\s+your\s+inbox|enter\s+the\s+code|we\s+just\s+sent|we\s+emailed|resend/i;
const OAUTH_CONSENT_PAGE_PATTERN = /使用\s*ChatGPT\s*登录到\s*Codex|sign\s+in\s+to\s+codex(?:\s+with\s+chatgpt)?|login\s+to\s+codex|log\s+in\s+to\s+codex|authorize|授权/i;
const OAUTH_CONSENT_FORM_SELECTOR = 'form[action*="/sign-in-with-chatgpt/" i][action*="/consent" i]';
const CONTINUE_ACTION_PATTERN = /继续|continue/i;
const ADD_PHONE_PAGE_PATTERN = /add[\s-]*phone|添加手机号|手机号码|手机号|phone\s+number|telephone/i;
const ADD_EMAIL_PAGE_PATTERN = /add\s+(?:your\s+)?email|verify\s+(?:your\s+)?email\s+address|添加邮箱|绑定邮箱|verify\s+email|email\s+address\s+verification/i;
const ACCOUNT_PICKER_PATTERN = /选择一个帐户以继续|select\s+(?:an?\s+)?account\s+to\s+continue|choose\s+(?:an?\s+)?account/i;
const ACCOUNT_PICKER_EXCLUDE_PATTERN = /登录至另一个帐户|sign\s+in\s+to\s+another|create\s+(?:an?\s+)?account|创建帐户|注册/i;
const PHONE_SIGNUP_TOGGLE_PATTERN = /use\s+(?:a\s+)?(?:phone|telephone|mobile)|continue\s+with\s+(?:a\s+)?(?:phone|telephone)|sign\s+(?:up|in)\s+with\s+(?:phone|telephone)|(?:phone|telephone)\s+number|手机号注册|使用手机号|使用电话号码|电话号码继续|手机号码继续/i;
const STEP5_SUBMIT_ERROR_PATTERN = /无法根据该信息创建帐户|请重试|unable\s+to\s+create\s+(?:your\s+)?account|couldn'?t\s+create\s+(?:your\s+)?account|something\s+went\s+wrong|invalid\s+(?:birthday|birth|date)|生日|出生日期/i;
const AUTH_TIMEOUT_ERROR_TITLE_PATTERN = /糟糕，出错了|something\s+went\s+wrong|oops/i;
const AUTH_TIMEOUT_ERROR_DETAIL_PATTERN = /operation\s+timed\s+out|timed\s+out|请求超时|操作超时/i;
const AUTH_ROUTE_ERROR_PATTERN = /405\s+method\s+not\s+allowed|route\s+error.*405/i;
const SIGNUP_USER_ALREADY_EXISTS_ERROR_PREFIX = 'SIGNUP_USER_ALREADY_EXISTS::';
const SIGNUP_EMAIL_EXISTS_PATTERN = /与此电子邮件地址相关联的帐户已存在|account\s+associated\s+with\s+this\s+email\s+address\s+already\s+exists|email\s+address.*already\s+exists/i;
const SIGNUP_PHONE_EXISTS_PATTERN = /与此(?:电话号码|手机号码|手机号)相关联的(?:帐户|账户)已存在|account\s+associated\s+with\s+this\s+phone\s+number\s+already\s+exists|phone\s+number.*already\s+(?:in\s+use|exists|registered|associated)/i;

const CF_TURNSTILE_PAGE_PATTERN = /just\s+a\s+moment|verify\s+(?:you\s+are|you're)\s+human|checking\s+(?:if|the|this|site)|security\s+check(?:\s+required)?|正在进行安全验证|请验证您是真人|完成安全验证|验证您是真人/i;
const CF_TURNSTILE_MAX_WAIT_MS = 120000;

const authPageRecovery = self.MultiPageAuthPageRecovery?.createAuthPageRecovery?.({
  detailPattern: AUTH_TIMEOUT_ERROR_DETAIL_PATTERN,
  getActionText,
  getPageTextSnapshot,
  humanPause,
  isActionEnabled,
  isVisibleElement,
  log,
  routeErrorPattern: AUTH_ROUTE_ERROR_PATTERN,
  simulateClick,
  sleep,
  throwIfStopped,
  titlePattern: AUTH_TIMEOUT_ERROR_TITLE_PATTERN,
}) || null;

function getVerificationErrorText() {
  const messages = [];
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[data-invalid="true"] + *',
    '[aria-invalid="true"] + *',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        messages.push(text);
      }
    });
  }

  const invalidInput = document.querySelector(`${VERIFICATION_CODE_INPUT_SELECTOR}[aria-invalid="true"], ${VERIFICATION_CODE_INPUT_SELECTOR}[data-invalid="true"]`);
  if (invalidInput) {
    const wrapper = invalidInput.closest('form, [data-rac], ._root_18qcl_51, div');
    if (wrapper) {
      const text = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        messages.push(text);
      }
    }
  }

  return messages.find((text) => INVALID_VERIFICATION_CODE_PATTERN.test(text)) || '';
}

function createSignupUserAlreadyExistsError() {
  return new Error(
    `${SIGNUP_USER_ALREADY_EXISTS_ERROR_PREFIX}步骤 4：检测到 user_already_exists，说明当前用户已存在，当前轮将直接停止。`
  );
}

function createSignupPhoneAlreadyExistsError() {
  return new Error(
    `${SIGNUP_USER_ALREADY_EXISTS_ERROR_PREFIX}步骤 3：检测到“与此电话号码相关联的帐户已存在”，号码已被绑定，当前轮将直接停止并进入下一轮。`
  );
}

function isStep5Ready() {
  return Boolean(
    document.querySelector('input[name="name"], input[autocomplete="name"], input[name="birthday"], input[name="age"], [role="spinbutton"][data-type="year"]')
  );
}

function getPageTextSnapshot() {
  return (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLoginVerificationDisplayedEmail() {
  const pageText = getPageTextSnapshot();
  const matches = pageText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return matches[0] ? String(matches[0]).trim().toLowerCase() : '';
}

function isCloudflareTurnstilePage() {
  if (/\/cdn-cgi\/challenge-platform\//i.test(location.pathname)) return true;
  const frames = document.querySelectorAll('iframe');
  for (const frame of frames) {
    if (/challenges\.cloudflare\.com/i.test(frame.src || '')) return true;
  }
  return CF_TURNSTILE_PAGE_PATTERN.test(getPageTextSnapshot());
}

function getCloudflareTurnstileIframeRect() {
  const frames = document.querySelectorAll('iframe');
  for (const frame of frames) {
    if (/challenges\.cloudflare\.com/i.test(frame.src || '')) {
      const rect = frame.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return {
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        };
      }
    }
  }
  return null;
}

async function waitForCloudflareTurnstileResolution() {
  if (!isCloudflareTurnstilePage()) return;
  log('检测到 Cloudflare 安全验证（过盾），正在尝试自动点击...', 'warn');

  const iframeRect = getCloudflareTurnstileIframeRect();
  if (iframeRect) {
    try {
      const clickResult = await sendBackgroundRequest('CF_TURNSTILE_CLICK_REQUEST', { rect: iframeRect });
      if (clickResult?.error) {
        log(`Cloudflare 自动点击失败：${clickResult.error}，请手动完成验证...`, 'warn');
      }
    } catch (err) {
      log(`Cloudflare 自动点击请求失败：${err.message}，请手动完成验证...`, 'warn');
    }
  } else {
    log('Cloudflare 验证页面未找到可点击的 iframe，请手动完成验证...', 'warn');
  }

  const start = Date.now();
  while (isCloudflareTurnstilePage()) {
    throwIfStopped();
    if (Date.now() - start >= CF_TURNSTILE_MAX_WAIT_MS) {
      throw new Error(`Cloudflare 安全验证超时（${CF_TURNSTILE_MAX_WAIT_MS / 1000} 秒未完成），请手动完成验证后重新执行步骤。URL: ${location.href}`);
    }
    await sleep(500);
  }
  log('Cloudflare 安全验证已通过，继续流程...', 'ok');
  await sleep(1000);
}

function getOAuthConsentForm() {
  return document.querySelector(OAUTH_CONSENT_FORM_SELECTOR);
}

function getPrimaryContinueButton() {
  const consentForm = getOAuthConsentForm();
  if (consentForm) {
    const formButtons = Array.from(
      consentForm.querySelectorAll('button[type="submit"], input[type="submit"], [role="button"]')
    );

    const formContinueButton = formButtons.find((el) => {
      if (!isVisibleElement(el)) return false;

      const ddActionName = el.getAttribute?.('data-dd-action-name') || '';
      return ddActionName === 'Continue' || CONTINUE_ACTION_PATTERN.test(getActionText(el));
    });
    if (formContinueButton) {
      return formContinueButton;
    }

    const firstVisibleSubmit = formButtons.find(isVisibleElement);
    if (firstVisibleSubmit) {
      return firstVisibleSubmit;
    }
  }

  const continueBtn = document.querySelector(
    `${OAUTH_CONSENT_FORM_SELECTOR} button[type="submit"], button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107`
  );
  if (continueBtn && isVisibleElement(continueBtn)) {
    return continueBtn;
  }

  const buttons = document.querySelectorAll('button, [role="button"]');
  return Array.from(buttons).find((el) => {
    if (!isVisibleElement(el)) return false;

    const ddActionName = el.getAttribute?.('data-dd-action-name') || '';
    return ddActionName === 'Continue' || CONTINUE_ACTION_PATTERN.test(getActionText(el));
  }) || null;
}

function isOAuthConsentPage() {
  const pageText = getPageTextSnapshot();
  if (OAUTH_CONSENT_PAGE_PATTERN.test(pageText)) {
    return true;
  }

  if (getOAuthConsentForm()) {
    return true;
  }

  return /\bcodex\b/i.test(pageText) && /\bchatgpt\b/i.test(pageText) && Boolean(getPrimaryContinueButton());
}

function isVerificationPageStillVisible() {
  if (getCurrentAuthRetryPageState('signup_password') || getCurrentAuthRetryPageState('login')) {
    return false;
  }
  if (getVerificationCodeTarget()) return true;
  if (findResendVerificationCodeTrigger({ allowDisabled: true })) return true;
  if (document.querySelector('form[action*="email-verification" i]')) return true;

  if (!isEmailVerificationPage()) {
    return false;
  }

  return VERIFICATION_PAGE_PATTERN.test(getPageTextSnapshot());
}

function isAddPhonePageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/add-phone(?:[/?#]|$)/i.test(path)) return true;

  const phoneInput = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
  );
  if (phoneInput && isVisibleElement(phoneInput)) {
    return /add[\s-]*(?:a\s+)?phone|添加手机号/i.test(getPageTextSnapshot());
  }

  return false;
}

function isPhoneLoginPageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/add-phone(?:[/?#]|$)/i.test(path)) return false;

  const phoneInput = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
  );
  return Boolean(phoneInput && isVisibleElement(phoneInput));
}

const PHONE_NUMBER_REJECTED_PATTERN = /invalid\s+phone|phone\s+(?:number\s+)?(?:is\s+)?invalid|unsupported\s+phone|enter\s+a\s+valid\s+phone|try\s+(?:a\s+)?different\s+(?:phone\s+)?number|too\s+many\s+attempts|already\s+(?:in\s+use|used|associated|registered|linked|taken)|(?:phone|number)\s+.*already|account.*(?:phone|number)|cannot\s+be\s+used\s+to\s+(?:create|sign)|unable\s+to\s+send|can't\s+send|cannot\s+send.*(?:text|sms|message)|(?:text|sms).*(?:failed|not\s+delivered)|无法向.*发送|无法发送.*短信|无法向.*电话|短信.*无法发送|无法使用|无效(?:的)?手机号|请输入有效|换(?:一个|个)?手机号|手机号码.*错误|手机号.*已(?:被|与|绑定|注册|关联|使用)|已(?:被|与).*手机号|该号码已/i;
const PHONE_SIGNUP_REJECTED_PREFIX = 'PHONE_SIGNUP_REJECTED::';

function isAddEmailPageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/add-email(?:[/?#]|$)/i.test(path)) return true;
  if (isAddPhonePageReady()) return false;
  const emailInput = getSignupEmailInput() || getLoginEmailInput();
  if (!emailInput) return false;
  return ADD_EMAIL_PAGE_PATTERN.test(getPageTextSnapshot());
}

function getAddEmailInput() {
  return getSignupEmailInput() || getLoginEmailInput() || null;
}

function findAccountPickerCards() {
  const candidates = document.querySelectorAll('button, [role="button"], a, [tabindex="0"]');
  return Array.from(candidates).filter(el => {
    if (!isVisibleElement(el)) return false;
    const text = (el.textContent || '').trim();
    if (!text || ACCOUNT_PICKER_EXCLUDE_PATTERN.test(text)) return false;
    // Phone formats like "+55 (11) 91363-0267" need parentheses / hyphens / dots tolerated.
    const hasPhone = /\+\d[\d\s()+\-.]{5,}\d/.test(text);
    const hasEmail = /[\w.]+@[\w.]+/.test(text);
    if (!hasPhone && !hasEmail) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 100;
  });
}

function normalizeAccountIdentifierDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function findAccountPickerSwitchTrigger() {
  const candidates = document.querySelectorAll('button, [role="button"], a, [tabindex="0"]');
  return Array.from(candidates).find(el => {
    if (!isVisibleElement(el)) return false;
    const text = (el.textContent || '').trim();
    return /登录至另一个帐户|sign\s+in\s+to\s+another\s+account/i.test(text);
  }) || null;
}

function isAccountPickerPage() {
  if (!ACCOUNT_PICKER_PATTERN.test(document.body?.innerText || '')) return false;
  return findAccountPickerCards().length > 0;
}

function findPhoneSignupTrigger() {
  const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el)) return false;
    return PHONE_SIGNUP_TOGGLE_PATTERN.test(getActionText(el));
  }) || null;
}

function getSignupPhoneInput() {
  const selectors = [
    'input[type="tel"]:not([maxlength="6"])',
    'input[name*="phone" i]',
    'input[id*="phone" i]',
    'input[autocomplete="tel"]',
  ];
  for (const selector of selectors) {
    const input = document.querySelector(selector);
    if (input && isVisibleElement(input)) return input;
  }
  return null;
}

function getAddPhoneInput() {
  const selectors = [
    'input[type="tel"]:not([maxlength="6"])',
    'input[name*="phone" i]',
    'input[id*="phone" i]',
    'input[autocomplete="tel"]',
  ];
  for (const selector of selectors) {
    const input = document.querySelector(selector);
    if (input && isVisibleElement(input)) return input;
  }
  return null;
}

function isAddPhoneNumberInput(el) {
  if (!el) return false;
  const maxLength = Number(el.getAttribute('maxlength') || el.maxLength || 0);
  if (maxLength > 0 && maxLength <= 8) return false;
  const attrs = [
    el.type,
    el.name,
    el.id,
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
  ].filter(Boolean).join(' ');
  return /tel|phone|mobile|手机号|手机号码|telephone/i.test(attrs);
}

function findPhoneCountrySelector() {
  const phoneInput = getSignupPhoneInput() || getAddPhoneInput();

  // Primary: look for known ARIA/attribute selectors that are buttons (not inputs)
  const selectors = [
    'select[name*="country" i]',
    'button[aria-label*="country" i]',
    'button[aria-haspopup="listbox"]',
    '[role="combobox"]',
  ];

  if (phoneInput) {
    const form = phoneInput.closest('form') || phoneInput.closest('div[role="form"]') || document.body;
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && isVisibleElement(el) && form.contains(el) && el !== phoneInput) {
        return el;
      }
    }
  }

  // Fallback: look for button/select near phone input showing a dialing code or country label
  if (phoneInput) {
    // Walk up parent divs (up to 6 levels) to find the phone row container
    let container = phoneInput.parentElement;
    for (let i = 0; i < 6 && container; i += 1) {
      const candidates = container.querySelectorAll('button, select, [role="button"], [role="combobox"]');
      for (const btn of candidates) {
        if (!isVisibleElement(btn) || btn === phoneInput) continue;
        const text = getActionText(btn);
        // Match by dialing code / country label; or by short text + SVG (flag-only buttons)
        if (/\+\d{1,3}|country|国家/i.test(text)) return btn;
        if (text.length < 12 && btn.querySelector('svg, img')) return btn;
      }
      container = container.parentElement;
    }
  }

  return null;
}

async function selectPhoneCountry(countryCode) {
  if (!countryCode) return { selected: false, reason: 'no_country_code' };

  const dialingCode = HEROSMS_COUNTRY_TO_DIALING_CODE[countryCode];
  const namePattern = HEROSMS_COUNTRY_TO_NAME_PATTERNS[countryCode];

  if (!dialingCode && !namePattern) {
    log(`未知的 HeroSMS 国家代码：${countryCode}，跳过国家选择。`, 'warn');
    return { selected: false, reason: 'unknown_country' };
  }

  const selector = findPhoneCountrySelector();
  if (!selector) {
    log(`未找到国家选择器（国家代码 ${countryCode}，拨号前缀 +${dialingCode || '?'}），跳过国家选择。URL: ${location.href}`, 'warn');
    return { selected: false, reason: 'no_selector' };
  }
  log(`找到国家选择器：tag=${selector.tagName} role=${selector.getAttribute('role') || ''} text="${getActionText(selector).slice(0, 40)}"`);

  // If it's a select element
  if (selector.tagName === 'SELECT') {
    const options = Array.from(selector.querySelectorAll('option'));
    const targetOption = options.find(opt => {
      const text = opt.textContent || opt.value || '';
      if (dialingCode && text.includes(`+${dialingCode}`)) return true;
      if (namePattern && namePattern.test(text)) return true;
      return false;
    });

    if (targetOption) {
      selector.value = targetOption.value;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      selector.dispatchEvent(new Event('input', { bubbles: true }));
      log(`已选择国家：${targetOption.textContent || targetOption.value}`);
      return { selected: true, country: targetOption.textContent || targetOption.value };
    }
  }

  // If it's a button/combobox, click to open dropdown
  simulateClick(selector);
  await sleep(750);

  function dialCodeMatches(text) {
    if (!dialingCode) return false;
    // Normalize whitespace, then check both +56 and +(56) formats
    const t = text.replace(/\s/g, '');
    return t.includes(`+${dialingCode}`) || t.includes(`+(${dialingCode})`);
  }

  function elementMatchesCountry(el) {
    if (!isVisibleElement(el)) return false;
    const text = getActionText(el);
    return dialCodeMatches(text) || Boolean(namePattern && namePattern.test(text));
  }

  function findCountryOptionInDropdown() {
    // Strategy 1: standard ARIA roles + listbox descendants
    const ariaCandidates = document.querySelectorAll(
      '[role="option"], li[data-value], li[role="menuitem"], ' +
      '[role="listbox"] li, [role="listbox"] button, [role="listbox"] [role="option"]'
    );
    for (const el of ariaCandidates) {
      if (el !== selector && elementMatchesCountry(el)) return el;
    }

    // Strategy 2: button / li / div inside a visible dialog or overlay
    const overlay = document.querySelector(
      '[role="dialog"]:not([aria-hidden="true"]), ' +
      '[role="listbox"]:not([aria-hidden="true"])'
    );
    const searchRoot = overlay || document.body;
    const overlayCandidates = searchRoot.querySelectorAll('button, li, div, [role="button"]');
    for (const el of overlayCandidates) {
      if (el === selector) continue;
      // Only match elements that are leaf-level or have a reasonable row height
      const rect = el.getBoundingClientRect();
      if (!isVisibleElement(el) || rect.height < 16) continue;
      if (elementMatchesCountry(el)) return el;
    }

    return null;
  }

  // If dropdown has a search input, type the country name to filter
  const searchInput = document.querySelector(
    '[role="dialog"] input, [role="listbox"] input, [role="listbox"] ~ * input, ' +
    'input[placeholder*="搜索" i], input[placeholder*="search" i], input[placeholder*="country" i], input[placeholder*="国家" i]'
  );
  // Try Chinese names first since the page renders in Chinese
  const countrySearchTerms = { 151: '智利', 73: '巴西', 16: '英国', 187: '美国' };
  const countrySearchTermsEn = { 151: 'Chile', 73: 'Brazil', 16: 'United Kingdom', 187: 'United States' };
  if (searchInput && isVisibleElement(searchInput)) {
    const term = countrySearchTerms[countryCode] || countrySearchTermsEn[countryCode];
    if (term) {
      fillInput(searchInput, term);
      await sleep(400);
    }
  }

  const targetOption = findCountryOptionInDropdown();

  if (targetOption) {
    // Scroll into view so the click registers correctly
    try { targetOption.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) { /* ignore */ }
    await humanPause(200, 500);
    simulateClick(targetOption);
    await sleep(300);
    log(`已选择国家：${getActionText(targetOption)}`);
    return { selected: true, country: getActionText(targetOption) };
  }

  // Close dropdown if we couldn't find the option
  simulateClick(selector);
  await sleep(200);

  log(`未找到匹配的国家选项（国家代码 ${countryCode}，拨号前缀 +${dialingCode || '?'}），跳过国家选择。URL: ${location.href}`, 'warn');
  return { selected: false, reason: 'option_not_found' };
}

function getPhoneSmsCodeTarget() {
  const target = getVerificationCodeTarget();
  if (!target) return null;
  if (target.type === 'single' && isAddPhoneNumberInput(target.element)) return null;
  return target;
}

function getAddPhoneSubmitButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) return direct;

  const candidates = document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    if (!text || RESEND_VERIFICATION_CODE_PATTERN.test(text)) return false;
    return /continue|next|submit|send\s+code|verify|继续|下一步|提交|发送|验证/i.test(text);
  }) || null;
}

function getPhonePageErrorText() {
  const text = getPageTextSnapshot();
  return PHONE_NUMBER_REJECTED_PATTERN.test(text) ? text : '';
}

const HEROSMS_COUNTRY_TO_DIALING_CODE_LENGTH = Object.freeze({
  151: 2, // Chile: +56
  73: 2,  // Brazil: +55
  16: 2,  // UK: +44
  187: 1, // USA: +1
  // Add more mappings as needed
});

const HEROSMS_COUNTRY_TO_DIALING_CODE = Object.freeze({
  151: '56',  // Chile
  73: '55',   // Brazil
  16: '44',   // UK
  187: '1',   // USA
});

const HEROSMS_COUNTRY_TO_NAME_PATTERNS = Object.freeze({
  151: /智利|chile/i,
  73: /巴西|brazil/i,
  16: /英国|united\s*kingdom|uk/i,
  187: /美国|united\s*states|usa|us/i,
});

function formatHeroSmsPhoneNumber(phone, countryCode = null) {
  const trimmed = String(phone || '').trim();
  if (!trimmed) return '';

  // Strip all non-digits first
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed;

  // If we have a country code, strip the international dialing prefix
  if (countryCode != null) {
    const prefixLength = HEROSMS_COUNTRY_TO_DIALING_CODE_LENGTH[countryCode];
    if (prefixLength && digits.length > prefixLength) {
      return digits.slice(prefixLength);
    }
  }

  return digits;
}

function sendBackgroundRequest(type, payload = undefined) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response = {}) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || String(runtimeError)));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response || {});
    });
  });
}

async function waitForPhoneCodePageOrRejection(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isStep8Ready()) return { success: true };
    const errorText = getPhonePageErrorText();
    if (errorText) return { rejected: true, errorText };
    const codeTarget = getPhoneSmsCodeTarget();
    if (codeTarget) return { codeTarget };
    await sleep(250);
  }
  return { rejected: true, errorText: '提交手机号后未进入短信验证码页。' };
}

async function waitForPhoneCodeSubmitOutcome(timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isStep8Ready()) return { success: true };
    const errorText = getVerificationErrorText() || getPhonePageErrorText();
    if (errorText) return { rejected: true, errorText };
    await sleep(250);
  }
  if (isStep8Ready()) return { success: true };
  return { rejected: true, errorText: '短信验证码提交后未进入 OAuth 授权页。' };
}

async function fillPhoneVerificationCode(code) {
  const target = getPhoneSmsCodeTarget();
  if (!target) throw new Error('未找到短信验证码输入框。URL: ' + location.href);

  if (target.type === 'split') {
    for (let i = 0; i < code.length && i < target.elements.length; i += 1) {
      fillInput(target.elements[i], code[i]);
      await sleep(80);
    }
    return;
  }

  fillInput(target.element, code);
}

async function submitAddPhoneCurrentForm(fallbackField = null) {
  const button = getAddPhoneSubmitButton();
  const form = button?.form || fallbackField?.form || button?.closest?.('form') || fallbackField?.closest?.('form') || null;
  await humanPause(350, 900);
  if (button && isActionEnabled(button)) {
    simulateClick(button);
    return;
  }
  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit(button || undefined);
    return;
  }
  if (fallbackField) {
    fallbackField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fallbackField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    return;
  }
  throw new Error('未找到手机号页面提交按钮。URL: ' + location.href);
}

function findChangePhoneNumberAction() {
  const pattern = /change\s+(?:phone\s+)?number|edit\s+(?:phone\s+)?number|use\s+(?:a\s+)?different\s+(?:phone\s+)?number|try\s+(?:a\s+)?different\s+(?:phone\s+)?number|back|编辑|更换(?:手机号|号码)?|修改(?:手机号|号码)?|换(?:一个|个)?(?:手机号|号码)?|返回|重新输入/i;
  const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    const text = getActionText(el);
    return text && pattern.test(text) && !RESEND_VERIFICATION_CODE_PATTERN.test(text);
  }) || null;
}

async function waitForAddPhoneInput(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    const input = getAddPhoneInput();
    if (input) return input;
    await sleep(200);
  }
  return null;
}

async function ensureAddPhoneNumberEntry() {
  const currentInput = getAddPhoneInput();
  if (currentInput) return currentInput;

  const changeAction = findChangePhoneNumberAction();
  if (changeAction) {
    await humanPause(350, 900);
    simulateClick(changeAction);
    const input = await waitForAddPhoneInput();
    if (input) return input;
  }

  if (history.length > 1) {
    history.back();
    const input = await waitForAddPhoneInput(8000);
    if (input) return input;
  }

  throw new Error('需要更换手机号，但当前页面无法回到手机号输入框。URL: ' + location.href);
}

async function requestPhoneActivation(type, payload = {}) {
  const result = await sendBackgroundRequest(type, payload);
  if (!result.ok || !result.activation?.phone) {
    throw new Error(result.reason || 'HeroSMS 未返回可用手机号。');
  }
  return result.activation;
}

async function requestPhoneSmsResend() {
  const result = await sendBackgroundRequest('PHONE_VERIFY_RESEND');
  if (!result.ok || result.requiresNewNumber || !result.resent) {
    return { requiresNewNumber: true, reason: result.reason || 'RESEND_UNAVAILABLE' };
  }

  const resendButton = findResendVerificationCodeTrigger();
  if (!resendButton) {
    return { requiresNewNumber: true, reason: 'MISSING_RESEND_BUTTON' };
  }

  await humanPause(450, 1000);
  simulateClick(resendButton);
  await sleep(1500);
  return { resent: true, resendCount: result.resendCount };
}

async function handleAddPhoneVerificationFlow() {
  if (!isAddPhonePageReady()) return { handled: false };

  let activation = await requestPhoneActivation('PHONE_VERIFY_START');
  for (let numberAttempt = 1; numberAttempt <= 5; numberAttempt += 1) {
    const phoneInput = await ensureAddPhoneNumberEntry();

    // Select country before filling phone number
    if (activation.country) {
      log(`手机号验证：正在选择国家（HeroSMS 代码 ${activation.country}）...`, 'info');
      const countryResult = await selectPhoneCountry(activation.country);
      if (countryResult.selected) {
        log(`手机号验证：国家已选择：${countryResult.country}`, 'info');
        await sleep(300);
      }
    }

    const formattedPhone = formatHeroSmsPhoneNumber(activation.phone, activation.country);
    log(`手机号验证：正在填写 HeroSMS 手机号 ${formattedPhone}（第 ${numberAttempt} 个号码）...`, 'info');
    await humanPause(500, 1200);
    fillInput(phoneInput, formattedPhone);
    await submitAddPhoneCurrentForm(phoneInput);

    const pageState = await waitForPhoneCodePageOrRejection();
    if (pageState.success) {
      await sendBackgroundRequest('PHONE_VERIFY_COMPLETE');
      return { handled: true, success: true };
    }
    if (pageState.rejected) {
      log(`手机号验证：号码被页面拒绝，准备更换号码：${pageState.errorText}`, 'warn');
      activation = await requestPhoneActivation('PHONE_VERIFY_NEW_NUMBER', { reason: 'phone_rejected' });
      continue;
    }

    while (true) {
      const pollResult = await sendBackgroundRequest('PHONE_VERIFY_POLL');
      if (pollResult.ok && pollResult.code) {
        log('手机号验证：已收到短信验证码，正在填写...', 'ok');
        await fillPhoneVerificationCode(String(pollResult.code));
        await submitAddPhoneCurrentForm(getPhoneSmsCodeTarget()?.element || null);
        const outcome = await waitForPhoneCodeSubmitOutcome();
        if (outcome.success) {
          await sendBackgroundRequest('PHONE_VERIFY_COMPLETE');
          log('手机号验证：短信验证码已通过。', 'ok');
          return { handled: true, success: true };
        }
        log(`手机号验证：短信验证码或号码被拒绝，准备更换号码：${outcome.errorText}`, 'warn');
        activation = await requestPhoneActivation('PHONE_VERIFY_NEW_NUMBER', { reason: 'code_or_phone_rejected' });
        break;
      }

      if (pollResult.requiresNewNumber && pollResult.reason !== 'POLL_TIMEOUT') {
        log(`手机号验证：当前号码不可用，准备更换号码：${pollResult.reason || 'unknown'}`, 'warn');
        activation = await requestPhoneActivation('PHONE_VERIFY_NEW_NUMBER', { reason: pollResult.reason || 'new_number_required' });
        break;
      }

      const resend = await requestPhoneSmsResend();
      if (resend.requiresNewNumber) {
        log(`手机号验证：当前号码重发次数已用完或无法重发，准备更换号码：${resend.reason}`, 'warn');
        activation = await requestPhoneActivation('PHONE_VERIFY_NEW_NUMBER', { reason: resend.reason || 'resend_unavailable' });
        break;
      }
      log(`手机号验证：已请求页面重发短信（第 ${resend.resendCount} 次，最多 ${resend.maxResendAttempts || 2} 次）。`, 'warn');
    }
  }

  throw new Error('手机号验证失败：已多次更换 HeroSMS 号码仍未通过。');
}

function isLoginPage() {
  return /\/log-in(?:[/?#]|$)/i.test(location.pathname || '');
}

function isStep8Ready() {
  const continueBtn = getPrimaryContinueButton();
  if (!continueBtn) return false;
  if (isVerificationPageStillVisible()) return false;
  if (isAddPhonePageReady()) return false;

  return isOAuthConsentPage();
}

function normalizeInlineText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function isStep5AllConsentText(text) {
  const normalizedText = normalizeInlineText(text).toLowerCase();
  if (!normalizedText) return false;

  return /i\s+agree\s+to\s+all\s+of\s+the\s+following/i.test(normalizedText)
    || normalizedText.includes('\u6211\u540c\u610f\u4ee5\u4e0b\u6240\u6709\u5404\u9879')
    || normalizedText.includes('\u540c\u610f\u4ee5\u4e0b\u6240\u6709\u5404\u9879')
    || normalizedText.includes('\u6211\u540c\u610f\u6240\u6709')
    || normalizedText.includes('\u5168\u90e8\u540c\u610f');
}

function findStep5AllConsentCheckbox() {
  const namedCandidates = Array.from(document.querySelectorAll('input[name="allCheckboxes"][type="checkbox"]'))
    .filter((el) => {
      const checkboxLabel = el.closest?.('label') || null;
      return isVisibleElement(el) || (checkboxLabel && isVisibleElement(checkboxLabel));
    });

  const namedMatch = namedCandidates.find((el) => {
    const checkboxLabel = el.closest?.('label') || null;
    const checkboxText = normalizeInlineText([
      checkboxLabel?.textContent || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('name') || '',
    ].filter(Boolean).join(' '));
    return isStep5AllConsentText(checkboxText);
  });
  if (namedMatch) {
    return namedMatch;
  }
  if (namedCandidates.length > 0) {
    return namedCandidates[0];
  }

  return Array.from(document.querySelectorAll('input[type="checkbox"]'))
    .find((el) => {
      const checkboxLabel = el.closest?.('label') || null;
      if (!isVisibleElement(el) && !(checkboxLabel && isVisibleElement(checkboxLabel))) {
        return false;
      }
      const checkboxText = normalizeInlineText([
        checkboxLabel?.textContent || '',
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('title') || '',
        el.getAttribute?.('name') || '',
      ].filter(Boolean).join(' '));
      return isStep5AllConsentText(checkboxText);
    }) || null;
}

function isStep5CheckboxChecked(checkbox) {
  if (!checkbox) return false;
  if (checkbox.checked === true) return true;

  const ariaChecked = String(
    checkbox.getAttribute?.('aria-checked')
    || checkbox.closest?.('[role="checkbox"]')?.getAttribute?.('aria-checked')
    || ''
  ).toLowerCase();
  return ariaChecked === 'true';
}

function findBirthdayReactAriaSelect(labelText) {
  const normalizedLabel = normalizeInlineText(labelText);
  const roots = document.querySelectorAll('.react-aria-Select');

  for (const root of roots) {
    const labelEl = Array.from(root.querySelectorAll('span')).find((el) => normalizeInlineText(el.textContent) === normalizedLabel);
    if (!labelEl) continue;

    const item = root.closest('[class*="selectItem"], ._selectItem_ppsls_113') || root.parentElement;
    const nativeSelect = item?.querySelector('[data-testid="hidden-select-container"] select') || null;
    const button = root.querySelector('button[aria-haspopup="listbox"]') || null;
    const valueEl = root.querySelector('.react-aria-SelectValue') || null;

    return { root, item, labelEl, nativeSelect, button, valueEl };
  }

  return null;
}

async function setReactAriaBirthdaySelect(control, value) {
  if (!control?.nativeSelect) {
    throw new Error('未找到可写入的生日下拉框。');
  }

  const desiredValue = String(value);
  const option = Array.from(control.nativeSelect.options).find((item) => item.value === desiredValue);
  if (!option) {
    throw new Error(`生日下拉框中不存在值 ${desiredValue}。`);
  }

  control.nativeSelect.value = desiredValue;
  option.selected = true;
  control.nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
  control.nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
}

function getStep5ErrorText() {
  const messages = [];
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[id$="-errors"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!isVisibleElement(el)) return;
      const text = normalizeInlineText(el.textContent);
      if (text) {
        messages.push(text);
      }
    });
  }

  const invalidField = Array.from(document.querySelectorAll('[aria-invalid="true"], [data-invalid="true"]'))
    .find((el) => isVisibleElement(el));
  if (invalidField) {
    const wrapper = invalidField.closest('form, fieldset, [data-rac], div');
    if (wrapper) {
      const text = normalizeInlineText(wrapper.textContent);
      if (text) {
        messages.push(text);
      }
    }
  }

  return messages.find((text) => STEP5_SUBMIT_ERROR_PATTERN.test(text)) || '';
}


function isSignupPasswordPage() {
  return /\/create-account\/password(?:[/?#]|$)/i.test(location.pathname || '');
}

function getSignupPasswordInput() {
  const input = document.querySelector('input[type="password"]');
  return input && isVisibleElement(input) ? input : null;
}

function getSignupPasswordSubmitButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll('button, [role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    return /继续|continue|submit|创建|create/i.test(text);
  }) || null;
}

function getAuthRetryButton({ allowDisabled = false } = {}) {
  if (authPageRecovery?.getAuthRetryButton) {
    return authPageRecovery.getAuthRetryButton({ allowDisabled });
  }

  const direct = document.querySelector('button[data-dd-action-name="Try again"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll('button, [role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    return /重试|try\s+again/i.test(text);
  }) || null;
}

function getAuthTimeoutErrorPageState(options = {}) {
  if (authPageRecovery?.getAuthTimeoutErrorPageState) {
    return authPageRecovery.getAuthTimeoutErrorPageState(options);
  }

  const { pathPatterns = [] } = options;
  const path = location.pathname || '';
  if (pathPatterns.length && !pathPatterns.some((pattern) => pattern.test(path))) {
    return null;
  }

  const retryButton = getAuthRetryButton({ allowDisabled: true });
  if (!retryButton) {
    return null;
  }

  const text = getPageTextSnapshot();
  const titleMatched = AUTH_TIMEOUT_ERROR_TITLE_PATTERN.test(text)
    || AUTH_TIMEOUT_ERROR_TITLE_PATTERN.test(document.title || '');
  const detailMatched = AUTH_TIMEOUT_ERROR_DETAIL_PATTERN.test(text);
  const routeErrorMatched = AUTH_ROUTE_ERROR_PATTERN.test(text);
  const maxCheckAttemptsBlocked = /max_check_attempts/i.test(text);
  const userAlreadyExistsBlocked = /user_already_exists/i.test(text);

  if (!titleMatched && !detailMatched && !routeErrorMatched && !maxCheckAttemptsBlocked && !userAlreadyExistsBlocked) {
    return null;
  }

  return {
    path,
    url: location.href,
    retryButton,
    retryEnabled: isActionEnabled(retryButton),
    titleMatched,
    detailMatched,
    routeErrorMatched,
    maxCheckAttemptsBlocked,
    userAlreadyExistsBlocked,
  };
}

function getSignupAuthRetryPathPatterns() {
  return [
    /\/create-account\/password(?:[/?#]|$)/i,
    /\/email-verification(?:[/?#]|$)/i,
  ];
}

function getLoginAuthRetryPathPatterns() {
  return [
    /\/log-in(?:[/?#]|$)/i,
    /\/email-verification(?:[/?#]|$)/i,
  ];
}

function getAuthRetryPathPatternsForFlow(flow = 'auth') {
  switch (flow) {
    case 'signup':
    case 'signup_password':
      return getSignupAuthRetryPathPatterns();
    case 'login':
      return getLoginAuthRetryPathPatterns();
    default:
      return [];
  }
}

function getCurrentAuthRetryPageState(flow = 'auth') {
  return getAuthTimeoutErrorPageState({
    pathPatterns: getAuthRetryPathPatternsForFlow(flow),
  });
}

async function recoverCurrentAuthRetryPage(payload = {}) {
  const {
    flow = 'auth',
    logLabel = '',
    maxClickAttempts = 5,
    pathPatterns = null,
    step = null,
    timeoutMs = 12000,
    waitAfterClickMs = 3000,
  } = payload;
  const resolvedPathPatterns = Array.isArray(pathPatterns)
    ? pathPatterns
    : getAuthRetryPathPatternsForFlow(flow);
  if (authPageRecovery?.recoverAuthRetryPage) {
    return authPageRecovery.recoverAuthRetryPage({
      logLabel,
      maxClickAttempts,
      pathPatterns: resolvedPathPatterns,
      step,
      timeoutMs,
      waitAfterClickMs,
    });
  }

  const maxIdlePolls = timeoutMs > 0
    ? Math.max(1, Math.ceil(timeoutMs / Math.max(1, 250)))
    : Number.POSITIVE_INFINITY;
  let clickCount = 0;
  let idlePollCount = 0;
  while (clickCount < maxClickAttempts) {
    throwIfStopped();
    const retryState = getAuthTimeoutErrorPageState({ pathPatterns: resolvedPathPatterns });
    if (!retryState) {
      return {
        recovered: clickCount > 0,
        clickCount,
        url: location.href,
      };
    }

    if (retryState.maxCheckAttemptsBlocked) {
      throw new Error('CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统，已完全停止流程，请不要短时间内多次进行重新发送验证码，连续刷新、反复点击重试会加重风控；请先关闭页面等待 15-30 分钟，让系统的临时限制自动解除。或者更换浏览器');
    }
    if (retryState.userAlreadyExistsBlocked) {
      throw createSignupUserAlreadyExistsError();
    }
    if (retryState.retryButton && retryState.retryEnabled) {
      idlePollCount = 0;
      clickCount += 1;
      log(`${logLabel || `步骤 ${step || '?'}：检测到重试页，正在点击“重试”恢复`}（第 ${clickCount} 次）...`, 'warn');
      await humanPause(300, 800);
      simulateClick(retryState.retryButton);
      const settleStart = Date.now();
      while (Date.now() - settleStart < waitAfterClickMs) {
        throwIfStopped();
        if (!getAuthTimeoutErrorPageState({ pathPatterns: resolvedPathPatterns })) {
          return {
            recovered: true,
            clickCount,
            url: location.href,
          };
        }
        await sleep(250);
      }
      continue;
    }

    idlePollCount += 1;
    if (idlePollCount >= maxIdlePolls) {
      throw new Error(`${logLabel || `步骤 ${step || '?'}：重试页恢复`}超时：重试按钮长时间不可点击。URL: ${location.href}`);
    }

    await sleep(250);
  }

  const finalRetryState = getAuthTimeoutErrorPageState({ pathPatterns: resolvedPathPatterns });
  if (!finalRetryState) {
    return {
      recovered: clickCount > 0,
      clickCount,
      url: location.href,
    };
  }
  if (finalRetryState.maxCheckAttemptsBlocked) {
    throw new Error('CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统，已完全停止流程，请不要短时间内多次进行重新发送验证码，连续刷新、反复点击重试会加重风控；请先关闭页面等待 15-30 分钟，让系统的临时限制自动解除。或者更换浏览器');
  }
  if (finalRetryState.userAlreadyExistsBlocked) {
    throw createSignupUserAlreadyExistsError();
  }

  throw new Error(`${logLabel || `步骤 ${step || '?'}：重试页恢复`}失败：已连续点击“重试” ${maxClickAttempts} 次，页面仍未恢复。URL: ${location.href}`);
}

function getSignupPasswordTimeoutErrorPageState() {
  return getAuthTimeoutErrorPageState({
    pathPatterns: getSignupAuthRetryPathPatterns(),
  });
}

function getLoginTimeoutErrorPageState() {
  return getAuthTimeoutErrorPageState({
    pathPatterns: [/\/log-in(?:[/?#]|$)/i],
  });
}

function getLoginEmailInput() {
  const candidates = document.querySelectorAll(
    'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"], input[type="tel"]:not([maxlength="6"])'
  );
  for (const el of candidates) {
    if (isVisibleElement(el)) return el;
  }
  return null;
}

function getLoginPasswordInput() {
  const input = document.querySelector('input[type="password"]');
  return input && isVisibleElement(input) ? input : null;
}

function getLoginSubmitButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    if (!text || ONE_TIME_CODE_LOGIN_PATTERN.test(text)) return false;
    return /continue|next|submit|sign\s*in|log\s*in|继续|下一步|登录/i.test(text);
  }) || null;
}

function inspectLoginAuthState() {
  const retryState = getLoginTimeoutErrorPageState();
  const verificationTarget = getVerificationCodeTarget();
  const passwordInput = getLoginPasswordInput();
  const emailInput = getLoginEmailInput();
  const switchTrigger = findOneTimeCodeLoginTrigger();
  const submitButton = getLoginSubmitButton({ allowDisabled: true });
  const verificationVisible = isVerificationPageStillVisible();
  const addPhonePage = isAddPhonePageReady();
  const addEmailPage = !addPhonePage && isAddEmailPageReady();
  const phoneLoginPage = !addPhonePage && !addEmailPage && isPhoneLoginPageReady();
  const consentReady = isStep8Ready();
  const oauthConsentPage = isOAuthConsentPage();
  const baseState = {
    state: 'unknown',
    url: location.href,
    path: location.pathname || '',
    displayedEmail: getLoginVerificationDisplayedEmail(),
    retryButton: retryState?.retryButton || null,
    retryEnabled: Boolean(retryState?.retryEnabled),
    titleMatched: Boolean(retryState?.titleMatched),
    detailMatched: Boolean(retryState?.detailMatched),
    maxCheckAttemptsBlocked: Boolean(retryState?.maxCheckAttemptsBlocked),
    verificationTarget,
    passwordInput,
    emailInput,
    submitButton,
    switchTrigger,
    verificationVisible,
    addPhonePage,
    addEmailPage,
    phoneLoginPage,
    oauthConsentPage,
    consentReady,
  };

  if (retryState) {
    return {
      ...baseState,
      state: 'login_timeout_error_page',
    };
  }

  if (addPhonePage) {
    return {
      ...baseState,
      state: 'add_phone_page',
    };
  }

  if (addEmailPage) {
    return {
      ...baseState,
      state: 'add_email_page',
    };
  }

  if (verificationTarget) {
    return {
      ...baseState,
      state: 'verification_page',
    };
  }

  if (oauthConsentPage || consentReady) {
    return {
      ...baseState,
      state: 'oauth_consent_page',
    };
  }

  if (isAccountPickerPage()) {
    return {
      ...baseState,
      state: 'account_picker_page',
    };
  }

  if (passwordInput || switchTrigger) {
    return {
      ...baseState,
      state: 'password_page',
    };
  }

  if (phoneLoginPage) {
    return {
      ...baseState,
      state: 'phone_login_page',
    };
  }

  if (emailInput) {
    return {
      ...baseState,
      state: 'email_page',
    };
  }

  if (verificationVisible) {
    return {
      ...baseState,
      state: 'verification_page',
    };
  }

  return baseState;
}

function serializeLoginAuthState(snapshot) {
  return {
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    path: snapshot?.path || location.pathname || '',
    displayedEmail: snapshot?.displayedEmail || '',
    retryEnabled: Boolean(snapshot?.retryEnabled),
    titleMatched: Boolean(snapshot?.titleMatched),
    detailMatched: Boolean(snapshot?.detailMatched),
    maxCheckAttemptsBlocked: Boolean(snapshot?.maxCheckAttemptsBlocked),
    hasVerificationTarget: Boolean(snapshot?.verificationTarget),
    hasPasswordInput: Boolean(snapshot?.passwordInput),
    hasEmailInput: Boolean(snapshot?.emailInput),
    hasSubmitButton: Boolean(snapshot?.submitButton),
    hasSwitchTrigger: Boolean(snapshot?.switchTrigger),
    verificationVisible: Boolean(snapshot?.verificationVisible),
    addPhonePage: Boolean(snapshot?.addPhonePage),
    addEmailPage: Boolean(snapshot?.addEmailPage),
    oauthConsentPage: Boolean(snapshot?.oauthConsentPage),
    consentReady: Boolean(snapshot?.consentReady),
  };
}

function getLoginAuthStateLabel(snapshot) {
  const state = snapshot?.state === 'oauth_consent_page' ? 'unknown' : snapshot?.state;
  switch (state) {
    case 'verification_page':
      return '登录验证码页';
    case 'password_page':
      return '密码页';
    case 'email_page':
      return '邮箱输入页';
    case 'login_timeout_error_page':
      return '登录超时报错页';
    case 'oauth_consent_page':
      return 'OAuth 授权页';
    case 'add_phone_page':
      return '手机号页';
    case 'phone_login_page':
      return '手机号登录页';
    case 'add_email_page':
      return '邮箱绑定页';
    case 'account_picker_page':
      return '账号选择页';
    default:
      return '未知页面';
  }
}

async function waitForKnownLoginAuthState(timeout = 15000) {
  await waitForCloudflareTurnstileResolution();
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isCloudflareTurnstilePage()) {
      await waitForCloudflareTurnstileResolution();
    }
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
    if (snapshot.state !== 'unknown') {
      return snapshot;
    }
    await sleep(200);
  }

  return snapshot;
}

async function waitForLoginVerificationPageReady(timeout = 10000) {
  const start = Date.now();
  let snapshot = inspectLoginAuthState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectLoginAuthState();
    if (snapshot.state === 'verification_page') {
      return snapshot;
    }
    if (snapshot.state !== 'unknown') {
      break;
    }
    await sleep(200);
  }

  throw new Error(
    `当前未进入登录验证码页面，请先重新完成步骤 7。当前状态：${getLoginAuthStateLabel(snapshot)}。URL: ${snapshot?.url || location.href}`
  );
}

function createStep6SuccessResult(snapshot, options = {}) {
  return {
    step6Outcome: 'success',
    state: snapshot?.state || 'verification_page',
    url: snapshot?.url || location.href,
    via: options.via || '',
    loginVerificationRequestedAt: options.loginVerificationRequestedAt || null,
    loginVerificationBypassed: Boolean(options.loginVerificationBypassed),
  };
}

async function handleStep6AddPhoneTransition(via, loginVerificationRequestedAt) {
  log('步骤 7：检测到手机号验证页面，改用 HeroSMS 完成手机号验证...', 'warn');
  await handleAddPhoneVerificationFlow();

  const snapshot = inspectLoginAuthState();
  if (snapshot.state === 'oauth_consent_page' || snapshot.consentReady || isStep8Ready()) {
    return createStep6SuccessResult(snapshot, {
      via,
      loginVerificationRequestedAt,
      loginVerificationBypassed: true,
    });
  }

  if (snapshot.state === 'verification_page') {
    return createStep6SuccessResult(snapshot, {
      via,
      loginVerificationRequestedAt,
    });
  }

  throw new Error(`手机号验证完成后未进入登录验证码页或 OAuth 授权页。URL: ${snapshot?.url || location.href}`);
}

async function handleStep7AddEmailTransition(via, loginVerificationRequestedAt) {
  log('步骤 7：检测到邮箱绑定页面，正在向后台请求 iCloud 别名邮箱...', 'info');
  const bindResult = await sendBackgroundRequest('EMAIL_BIND_REQUEST');
  if (!bindResult?.ok || !bindResult?.email) {
    throw new Error(bindResult?.reason || '后台未返回可用邮箱地址，无法完成邮箱绑定。');
  }
  const email = bindResult.email;
  log(`步骤 7：已获取邮箱 ${email}，正在填写邮箱绑定表单...`);

  const emailInput = getAddEmailInput();
  if (!emailInput) {
    throw new Error(`步骤 7：未找到邮箱输入框，无法绑定邮箱。URL: ${location.href}`);
  }

  await humanPause(500, 1200);
  fillInput(emailInput, email);
  log('步骤 7：邮箱已填写，正在提交...');

  const submitBtn = getLoginSubmitButton({ allowDisabled: false })
    || document.querySelector('button[type="submit"], input[type="submit"]');
  if (!submitBtn) {
    throw new Error('步骤 7：未找到邮箱绑定表单提交按钮。');
  }

  const emailBindingRequestedAt = Date.now();
  await triggerLoginSubmitAction(submitBtn, emailInput);

  await sleep(1500);
  const snapshot = normalizeStep6Snapshot(await waitForKnownLoginAuthState(20000));

  if (snapshot.state === 'verification_page') {
    return createStep6SuccessResult(snapshot, {
      via,
      loginVerificationRequestedAt: emailBindingRequestedAt,
    });
  }

  if (snapshot.state === 'oauth_consent_page' || snapshot.consentReady) {
    return createStep6SuccessResult(snapshot, {
      via,
      loginVerificationRequestedAt: emailBindingRequestedAt,
      loginVerificationBypassed: true,
    });
  }

  throw new Error(`步骤 7：邮箱绑定提交后未进入验证码页或 OAuth 授权页，当前状态：${getLoginAuthStateLabel(snapshot)}。URL: ${snapshot?.url || location.href}`);
}

function createStep6RecoverableResult(reason, snapshot, options = {}) {
  return {
    step6Outcome: 'recoverable',
    reason,
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    message: options.message || '',
    loginVerificationRequestedAt: options.loginVerificationRequestedAt || null,
  };
}

async function createStep6LoginTimeoutRecoverableResult(reason, snapshot, message) {
  const resolvedSnapshot = normalizeStep6Snapshot(snapshot || inspectLoginAuthState());
  if (resolvedSnapshot?.state === 'login_timeout_error_page') {
    try {
      const recoveryResult = await recoverCurrentAuthRetryPage({
        flow: 'login',
        logLabel: '步骤 7：检测到登录超时报错，正在点击“重试”恢复当前页面',
        step: 7,
        timeoutMs: 12000,
      });
      if (recoveryResult?.recovered) {
        log('步骤 7：登录超时报错页已点击“重试”，准备重新执行当前步骤。', 'warn');
      }
    } catch (error) {
      if (/CF_SECURITY_BLOCKED::/i.test(String(error?.message || error || ''))) {
        throw error;
      }
      log(`步骤 7：登录超时报错页自动点击“重试”失败：${error.message}`, 'warn');
    }
  }

  return createStep6RecoverableResult(reason, resolvedSnapshot, {
    message,
  });
}

function normalizeStep6Snapshot(snapshot) {
  if (snapshot?.state !== 'oauth_consent_page') {
    return snapshot;
  }

  return {
    ...snapshot,
    state: 'unknown',
  };
}

function throwForStep6FatalState(snapshot) {
  snapshot = normalizeStep6Snapshot(snapshot);
  switch (snapshot?.state) {
    case 'oauth_consent_page':
      throw new Error(`当前页面已进入 OAuth 授权页，未经过登录验证码页，无法完成步骤 7。URL: ${snapshot.url}`);
    case 'add_phone_page':
      throw new Error(`当前页面已进入手机号页面，未经过登录验证码页，无法完成步骤 7。URL: ${snapshot.url}`);
    case 'add_email_page':
      throw new Error(`当前页面已进入邮箱绑定页，未经过登录验证码页，无法完成步骤 7。URL: ${snapshot.url}`);
    case 'unknown':
      throw new Error(`无法识别当前登录页面状态。URL: ${snapshot?.url || location.href}`);
    default:
      return;
  }
}

async function triggerLoginSubmitAction(button, fallbackField) {
  const form = button?.form || fallbackField?.form || button?.closest?.('form') || fallbackField?.closest?.('form') || null;

  await humanPause(400, 1100);
  if (button && isActionEnabled(button)) {
    simulateClick(button);
    return;
  }

  if (form && typeof form.requestSubmit === 'function') {
    if (button && button.form === form) {
      form.requestSubmit(button);
    } else {
      form.requestSubmit();
    }
    return;
  }

  if (button && typeof button.click === 'function') {
    button.click();
    return;
  }

  throw new Error('未找到可用的登录提交按钮。URL: ' + location.href);
}

function isSignupPasswordErrorPage() {
  return Boolean(getSignupPasswordTimeoutErrorPageState());
}

function buildStep7RestartFromStep6Marker(reason, url = location.href) {
  return `STEP7_RESTART_FROM_STEP6::${reason || 'unknown'}::${url || ''}`;
}

function getStep7RestartFromStep6Signal() {
  if (!isLoginPage() || !getLoginTimeoutErrorPageState()) {
    return null;
  }

  return {
    error: buildStep7RestartFromStep6Marker('login_timeout_error_page', location.href),
    restartFromStep6: true,
    reason: 'login_timeout_error_page',
    url: location.href,
  };
}

function isSignupEmailAlreadyExistsPage() {
  return isSignupPasswordPage() && SIGNUP_EMAIL_EXISTS_PATTERN.test(getPageTextSnapshot());
}

function isSignupPhoneAlreadyExistsPage() {
  return isSignupPasswordPage() && SIGNUP_PHONE_EXISTS_PATTERN.test(getPageTextSnapshot());
}

function inspectSignupVerificationState() {
  if (isStep5Ready()) {
    return { state: 'step5' };
  }

  if (isSignupPasswordErrorPage()) {
    const timeoutPage = getSignupPasswordTimeoutErrorPageState();
    return {
      state: 'error',
      retryButton: timeoutPage?.retryButton || null,
      userAlreadyExistsBlocked: Boolean(timeoutPage?.userAlreadyExistsBlocked),
    };
  }

  if (isVerificationPageStillVisible()) {
    return { state: 'verification' };
  }

  if (isSignupPhoneAlreadyExistsPage()) {
    return { state: 'phone_exists' };
  }

  if (isSignupEmailAlreadyExistsPage()) {
    return { state: 'email_exists' };
  }

  const passwordInput = getSignupPasswordInput();
  if (passwordInput) {
    return {
      state: 'password',
      passwordInput,
      submitButton: getSignupPasswordSubmitButton({ allowDisabled: true }),
    };
  }

  return { state: 'unknown' };
}

async function waitForSignupVerificationTransition(timeout = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const snapshot = inspectSignupVerificationState();
    if (snapshot.state === 'step5' || snapshot.state === 'verification' || snapshot.state === 'error' || snapshot.state === 'email_exists' || snapshot.state === 'phone_exists') {
      return snapshot;
    }

    await sleep(200);
  }

  return inspectSignupVerificationState();
}

async function prepareSignupVerificationFlow(payload = {}, timeout = 30000) {
  const { password } = payload;
  const prepareSource = String(payload?.prepareSource || '').trim() || 'step4_execute';
  const prepareLogLabel = String(payload?.prepareLogLabel || '').trim()
    || (prepareSource === 'step3_finalize' ? '步骤 3 收尾' : '步骤 4 执行');
  const start = Date.now();
  let recoveryRound = 0;
  const maxRecoveryRounds = 3;

  while (Date.now() - start < timeout && recoveryRound < maxRecoveryRounds) {
    throwIfStopped();

    const roundNo = recoveryRound + 1;
    log(`${prepareLogLabel}：等待页面进入验证码阶段（第 ${roundNo}/${maxRecoveryRounds} 轮，先等待 5 秒）...`, 'info');
    const snapshot = await waitForSignupVerificationTransition(5000);

    if (snapshot.state === 'step5') {
      log(`${prepareLogLabel}：页面已进入验证码后的下一阶段，本步骤按已完成处理。`, 'ok');
      return { ready: true, alreadyVerified: true, retried: recoveryRound, prepareSource };
    }

    if (snapshot.state === 'verification') {
      log(`${prepareLogLabel}：验证码页面已就绪${recoveryRound ? `（期间自动恢复 ${recoveryRound} 次）` : ''}。`, 'ok');
      return { ready: true, retried: recoveryRound, prepareSource };
    }

    if (snapshot.state === 'phone_exists') {
      throw createSignupPhoneAlreadyExistsError();
    }

    if (snapshot.state === 'email_exists') {
      throw new Error('当前邮箱已存在，需要重新开始新一轮。');
    }

    recoveryRound += 1;

    if (snapshot.state === 'error') {
      if (snapshot.userAlreadyExistsBlocked) {
        throw createSignupUserAlreadyExistsError();
      }
      await recoverCurrentAuthRetryPage({
        flow: 'signup',
        logLabel: `${prepareLogLabel}：检测到注册认证重试页，正在点击“重试”恢复（第 ${recoveryRound}/${maxRecoveryRounds} 次）`,
        step: 4,
        timeoutMs: 12000,
      });
      continue;
    }

    if (snapshot.state === 'password') {
      if (!password) {
        throw new Error('当前回到了密码页，但没有可用密码，无法自动重新提交。');
      }

      if ((snapshot.passwordInput.value || '') !== password) {
        log(`${prepareLogLabel}：页面仍停留在密码页，正在重新填写密码...`, 'warn');
        await humanPause(450, 1100);
        fillInput(snapshot.passwordInput, password);
      }

      if (snapshot.submitButton && isActionEnabled(snapshot.submitButton)) {
        log(`${prepareLogLabel}：页面仍停留在密码页，正在重新点击“继续”（第 ${recoveryRound}/${maxRecoveryRounds} 次）...`, 'warn');
        await humanPause(350, 900);
        simulateClick(snapshot.submitButton);
        await sleep(1200);
        continue;
      }

      log(`${prepareLogLabel}：页面仍停留在密码页，但“继续”按钮暂不可用，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
      continue;
    }

    log(`${prepareLogLabel}：页面仍在切换中，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
  }

  throw new Error(`等待注册验证码页面就绪超时或自动恢复失败（已尝试 ${recoveryRound}/${maxRecoveryRounds} 轮）。URL: ${location.href}`);
}


async function waitForVerificationSubmitOutcome(step, timeout) {
  const resolvedTimeout = timeout ?? (step === 8 ? 30000 : 12000);
  const start = Date.now();

  while (Date.now() - start < resolvedTimeout) {
    throwIfStopped();

    if (step === 4) {
      const signupRetryState = getCurrentAuthRetryPageState('signup');
      if (signupRetryState?.userAlreadyExistsBlocked) {
        throw createSignupUserAlreadyExistsError();
      }
    }

    const errorText = getVerificationErrorText();
    if (errorText) {
      return { invalidCode: true, errorText };
    }

    if (step === 4 && isStep5Ready()) {
      return { success: true };
    }

    if (step === 8 && isStep8Ready()) {
      return { success: true };
    }

    if (step === 8 && isAddPhonePageReady()) {
      await handleAddPhoneVerificationFlow();
      continue;
    }

    await sleep(150);
  }

  if (step === 4) {
    const signupRetryState = getCurrentAuthRetryPageState('signup');
    if (signupRetryState?.userAlreadyExistsBlocked) {
      throw createSignupUserAlreadyExistsError();
    }
  }

  if (isVerificationPageStillVisible()) {
    return {
      invalidCode: true,
      errorText: getVerificationErrorText() || '提交后仍停留在验证码页面，准备重新发送验证码。',
    };
  }

  return { success: true, assumed: true };
}

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('未提供验证码。');

  log(`步骤 ${step}：正在填写验证码：${code}`);

  if (step === 8) {
    await waitForLoginVerificationPageReady();
  }

  // Find code input — could be a single input or multiple separate inputs
  // Retry with 405 error recovery if needed
  const maxRetries = 3;
  let codeInput = null;

  for (let retry = 0; retry <= maxRetries; retry++) {
    throwIfStopped();

    // Before looking for input, check if page is in 405 error state
    if (is405MethodNotAllowedPage()) {
      log(`步骤 ${step}：检测到 405 错误页面，正在恢复...`, 'warn');
      await handle405ResendError(step, 30000);
      continue;
    }

    try {
      codeInput = await waitForElement(VERIFICATION_CODE_INPUT_SELECTOR, 10000);
      break; // Found it
    } catch {
      // Check for multiple single-digit inputs (common pattern)
      const singleInputs = document.querySelectorAll('input[maxlength="1"]');
      if (singleInputs.length >= 6) {
        log(`步骤 ${step}：发现分开的单字符验证码输入框，正在逐个填写...`);
        for (let i = 0; i < 6 && i < singleInputs.length; i++) {
          fillInput(singleInputs[i], code[i]);
          await sleep(100);
        }
        const outcome = await waitForVerificationSubmitOutcome(step);
        if (outcome.invalidCode) {
          log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
        } else if (outcome.addPhonePage) {
          log(`步骤 ${step}：验证码提交后页面进入手机号页面，当前流程将停止自动授权。`, 'warn');
        } else {
          log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
        }
        return outcome;
      }

      // No input found — check if it's a 405 error and can be recovered
      if (is405MethodNotAllowedPage() && retry < maxRetries) {
        log(`步骤 ${step}：未找到验证码输入框且页面出现 405 错误，正在恢复...`, 'warn');
        await handle405ResendError(step, 30000);
        continue;
      }

      throw new Error('未找到验证码输入框。URL: ' + location.href);
    }
  }

  if (!codeInput) {
    throw new Error('未找到验证码输入框。URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`步骤 ${step}：验证码已填写`);

  // Report complete BEFORE submit (page may navigate away)

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`步骤 ${step}：验证码已提交`);
  }

  const outcome = await waitForVerificationSubmitOutcome(step);
  if (outcome.invalidCode) {
    log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
  } else if (outcome.addPhonePage) {
    log(`步骤 ${step}：验证码提交后页面进入手机号页面，当前流程将停止自动授权。`, 'warn');
  } else {
    log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
  }

  return outcome;
}

// ============================================================
// Step 7: Login with registered account (on OAuth auth page)
// ============================================================

async function waitForStep6EmailSubmitTransition(emailSubmittedAt, timeout = 12000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

    if (snapshot.state === 'verification_page') {
      return {
        action: 'done',
        result: createStep6SuccessResult(snapshot, {
          via: 'email_submit',
          loginVerificationRequestedAt: emailSubmittedAt,
        }),
      };
    }

    if (snapshot.state === 'password_page') {
      return { action: 'password', snapshot };
    }

    if (snapshot.state === 'login_timeout_error_page') {
      return {
        action: 'recoverable',
        result: await createStep6LoginTimeoutRecoverableResult(
          'login_timeout_error_page',
          snapshot,
          '提交邮箱后进入登录超时报错页。'
        ),
      };
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`提交邮箱后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      return {
        action: 'done',
        result: await handleStep6AddPhoneTransition('email_submit_add_phone', emailSubmittedAt),
      };
    }

    if (snapshot.state === 'add_email_page') {
      return {
        action: 'done',
        result: await handleStep7AddEmailTransition('email_submit_add_email', emailSubmittedAt),
      };
    }

    await sleep(250);
  }

  snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
  if (snapshot.state === 'verification_page') {
    return {
      action: 'done',
      result: createStep6SuccessResult(snapshot, {
        via: 'email_submit',
        loginVerificationRequestedAt: emailSubmittedAt,
      }),
    };
  }
  if (snapshot.state === 'password_page') {
    return { action: 'password', snapshot };
  }
  if (snapshot.state === 'login_timeout_error_page') {
    return {
      action: 'recoverable',
      result: await createStep6LoginTimeoutRecoverableResult(
        'login_timeout_error_page',
        snapshot,
        '提交邮箱后进入登录超时报错页。'
      ),
    };
  }
  if (snapshot.state === 'oauth_consent_page') {
    throw new Error(`提交邮箱后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'add_phone_page') {
    return {
      action: 'done',
      result: await handleStep6AddPhoneTransition('email_submit_add_phone', emailSubmittedAt),
    };
  }
  if (snapshot.state === 'add_email_page') {
    return {
      action: 'done',
      result: await handleStep7AddEmailTransition('email_submit_add_email', emailSubmittedAt),
    };
  }

  return {
    action: 'recoverable',
    result: createStep6RecoverableResult('email_submit_stalled', snapshot, {
      message: '提交邮箱后长时间未进入密码页或登录验证码页。',
    }),
  };
}

async function waitForStep6PasswordSubmitTransition(passwordSubmittedAt, timeout = 10000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

    if (snapshot.state === 'verification_page') {
      return {
        action: 'done',
        result: createStep6SuccessResult(snapshot, {
          via: 'password_submit',
          loginVerificationRequestedAt: passwordSubmittedAt,
        }),
      };
    }

    if (snapshot.state === 'login_timeout_error_page') {
      return {
        action: 'recoverable',
        result: await createStep6LoginTimeoutRecoverableResult(
          'login_timeout_error_page',
          snapshot,
          '提交密码后进入登录超时报错页。'
        ),
      };
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`提交密码后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      return {
        action: 'done',
        result: await handleStep6AddPhoneTransition('password_submit_add_phone', passwordSubmittedAt),
      };
    }

    if (snapshot.state === 'add_email_page') {
      return {
        action: 'done',
        result: await handleStep7AddEmailTransition('password_submit_add_email', passwordSubmittedAt),
      };
    }

    await sleep(250);
  }

  snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
  if (snapshot.state === 'verification_page') {
    return {
      action: 'done',
      result: createStep6SuccessResult(snapshot, {
        via: 'password_submit',
        loginVerificationRequestedAt: passwordSubmittedAt,
      }),
    };
  }
  if (snapshot.state === 'login_timeout_error_page') {
    return {
      action: 'recoverable',
      result: await createStep6LoginTimeoutRecoverableResult(
        'login_timeout_error_page',
        snapshot,
        '提交密码后进入登录超时报错页。'
      ),
    };
  }
  if (snapshot.state === 'oauth_consent_page') {
    throw new Error(`提交密码后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'add_phone_page') {
    return {
      action: 'done',
      result: await handleStep6AddPhoneTransition('password_submit_add_phone', passwordSubmittedAt),
    };
  }
  if (snapshot.state === 'add_email_page') {
    return {
      action: 'done',
      result: await handleStep7AddEmailTransition('password_submit_add_email', passwordSubmittedAt),
    };
  }
  if (snapshot.state === 'password_page' && snapshot.switchTrigger) {
    return { action: 'switch', snapshot };
  }

  return {
    action: 'recoverable',
    result: createStep6RecoverableResult('password_submit_stalled', snapshot, {
      message: '提交密码后仍未进入登录验证码页。',
    }),
  };
}

async function waitForStep6SwitchTransition(loginVerificationRequestedAt, timeout = 10000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

    if (snapshot.state === 'verification_page') {
      return createStep6SuccessResult(snapshot, {
        via: 'switch_to_one_time_code_login',
        loginVerificationRequestedAt,
      });
    }

    if (snapshot.state === 'login_timeout_error_page') {
      return await createStep6LoginTimeoutRecoverableResult(
        'login_timeout_error_page',
        snapshot,
        '切换到一次性验证码登录后进入登录超时报错页。'
      );
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`切换到一次性验证码登录后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      return handleStep6AddPhoneTransition('switch_to_one_time_code_login_add_phone', loginVerificationRequestedAt);
    }

    if (snapshot.state === 'add_email_page') {
      return handleStep7AddEmailTransition('switch_to_one_time_code_login_add_email', loginVerificationRequestedAt);
    }

    await sleep(250);
  }

  snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
  if (snapshot.state === 'verification_page') {
    return createStep6SuccessResult(snapshot, {
      via: 'switch_to_one_time_code_login',
      loginVerificationRequestedAt,
    });
  }
  if (snapshot.state === 'login_timeout_error_page') {
    return await createStep6LoginTimeoutRecoverableResult(
      'login_timeout_error_page',
      snapshot,
      '切换到一次性验证码登录后进入登录超时报错页。'
    );
  }
  if (snapshot.state === 'oauth_consent_page') {
    throw new Error(`切换到一次性验证码登录后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'add_phone_page') {
    return handleStep6AddPhoneTransition('switch_to_one_time_code_login_add_phone', loginVerificationRequestedAt);
  }
  if (snapshot.state === 'add_email_page') {
    return handleStep7AddEmailTransition('switch_to_one_time_code_login_add_email', loginVerificationRequestedAt);
  }

  return createStep6RecoverableResult('one_time_code_switch_stalled', snapshot, {
    message: '点击一次性验证码登录后仍未进入登录验证码页。',
  });
}

async function step6SwitchToOneTimeCodeLogin(snapshot) {
  const switchTrigger = snapshot?.switchTrigger || findOneTimeCodeLoginTrigger();
  if (!switchTrigger || !isActionEnabled(switchTrigger)) {
    return createStep6RecoverableResult('missing_one_time_code_trigger', normalizeStep6Snapshot(inspectLoginAuthState()), {
      message: '当前登录页没有可用的一次性验证码登录入口。',
    });
  }

  log('步骤 7：已检测到一次性验证码登录入口，准备切换...');
  const loginVerificationRequestedAt = Date.now();
  await humanPause(350, 900);
  simulateClick(switchTrigger);
  log('步骤 7：已点击一次性验证码登录');
  await sleep(1200);
  return waitForStep6SwitchTransition(loginVerificationRequestedAt);
}

async function step6LoginFromPasswordPage(payload, snapshot) {
  const currentSnapshot = normalizeStep6Snapshot(snapshot || inspectLoginAuthState());
  const hasPassword = Boolean(String(payload?.password || '').trim());

  if (currentSnapshot.passwordInput) {
    if (!hasPassword) {
      if (currentSnapshot.switchTrigger) {
        log('步骤 7：当前未提供密码，改走一次性验证码登录。', 'warn');
        return step6SwitchToOneTimeCodeLogin(currentSnapshot);
      }

      return createStep6RecoverableResult('missing_password_and_one_time_code_trigger', currentSnapshot, {
        message: '登录时未提供密码，且当前页面没有可用的一次性验证码登录入口。',
      });
    }

    log('步骤 7：已进入密码页，准备填写密码...');
    await humanPause(550, 1450);
    fillInput(currentSnapshot.passwordInput, payload.password);
    log('步骤 7：已填写密码');

    await sleep(500);
    const passwordSubmittedAt = Date.now();
    await triggerLoginSubmitAction(currentSnapshot.submitButton, currentSnapshot.passwordInput);
    log('步骤 7：已提交密码');

    const transition = await waitForStep6PasswordSubmitTransition(passwordSubmittedAt);
    if (transition.action === 'done') {
      log('步骤 7：已进入登录验证码页面。', 'ok');
      return transition.result;
    }
    if (transition.action === 'recoverable') {
      log(`步骤 7：${transition.result.message || '提交密码后仍未进入登录验证码页面，准备重新执行步骤 7。'}`, 'warn');
      return transition.result;
    }
    if (transition.action === 'switch') {
      return step6SwitchToOneTimeCodeLogin(transition.snapshot);
    }

    return createStep6RecoverableResult('password_submit_unknown', normalizeStep6Snapshot(inspectLoginAuthState()), {
      message: '提交密码后未得到可用的下一步状态。',
    });
  }

  if (currentSnapshot.switchTrigger) {
    return step6SwitchToOneTimeCodeLogin(currentSnapshot);
  }

  return createStep6RecoverableResult('password_page_unactionable', currentSnapshot, {
    message: '当前停留在登录页，但没有可提交密码的输入框，也没有一次性验证码登录入口。',
  });
}

async function step6LoginFromPhonePage(payload, snapshot) {
  const phone = payload?.phone || '';
  const phoneCountry = payload?.phoneCountry || null;
  if (!phone) {
    throw new Error('步骤 7：手机号登录模式下 payload 未携带手机号。');
  }

  log(`步骤 7：检测到手机号登录页，正在填写手机号...`);

  let phoneInput = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"], input[aria-label*="phone" i], input[aria-label*="电话" i], input[aria-label*="手机" i]'
  );
  // Broader fallback: when the page URL is the phone-login variant, treat any non-password/non-hidden
  // visible input as the phone field (OpenAI's phone login input sometimes has generic attributes).
  if (!phoneInput || !isVisibleElement(phoneInput)) {
    const isPhoneLoginUrl = /\busernameKind=phone_number\b/i.test(location.href);
    if (isPhoneLoginUrl) {
      const allInputs = Array.from(document.querySelectorAll('input')).filter(el => {
        if (!isVisibleElement(el)) return false;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !['password', 'hidden', 'checkbox', 'radio', 'submit', 'button'].includes(type);
      });
      if (allInputs.length === 1) {
        phoneInput = allInputs[0];
        log(`步骤 7：通过 URL=usernameKind=phone_number 兜底匹配到唯一可见输入框作为手机号输入框（name=${phoneInput.getAttribute('name') || ''} type=${phoneInput.getAttribute('type') || ''}）。`, 'info');
      } else if (allInputs.length > 1) {
        log(`步骤 7：URL 是 phone_number 但页面有多个可见输入框（${allInputs.length} 个），请检查。`, 'warn');
      }
    }
  }
  if (!phoneInput || !isVisibleElement(phoneInput)) {
    // Dump all inputs for diagnosis
    const inputsDump = Array.from(document.querySelectorAll('input')).map(el => ({
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      visible: isVisibleElement(el),
    }));
    log(`步骤 7 [诊断]: 页面所有 input 节点 = ${JSON.stringify(inputsDump)}`, 'warn');
    throw new Error(`步骤 7：手机号登录页未找到手机号输入框。URL: ${location.href}`);
  }
  log(`步骤 7：找到手机号输入框 name=${phoneInput.getAttribute('name') || ''} type=${phoneInput.getAttribute('type') || ''} autocomplete=${phoneInput.getAttribute('autocomplete') || ''}`);

  if (phoneCountry) {
    log(`步骤 7：正在选择国家（HeroSMS 代码 ${phoneCountry}）...`);
    const countryResult = await selectPhoneCountry(phoneCountry);
    if (countryResult.selected) {
      log(`步骤 7：已选择国家：${countryResult.country}`);
      await sleep(300);
    } else {
      log(`步骤 7：国家选择失败（原因: ${countryResult.reason}），将使用当前默认国家填入号码。`, 'warn');
    }
  } else {
    log('步骤 7：payload 未携带 phoneCountry，跳过国家选择。', 'warn');
  }

  const formattedPhone = formatHeroSmsPhoneNumber(phone, phoneCountry);
  log(`步骤 7：准备填入手机号 phone=${phone} phoneCountry=${phoneCountry} formatted=${formattedPhone}`);
  await humanPause(400, 1000);
  fillInput(phoneInput, formattedPhone);
  log('步骤 7：手机号已填写');

  await sleep(500);
  const phoneSubmittedAt = Date.now();
  const submitButton = getLoginSubmitButton({ allowDisabled: false }) || snapshot?.submitButton;
  await triggerLoginSubmitAction(submitButton, phoneInput);
  log('步骤 7：手机号已提交，等待跳转...');

  await sleep(1000);
  const next = normalizeStep6Snapshot(await waitForKnownLoginAuthState(15000));

  if (next.state === 'password_page') {
    return step6LoginFromPasswordPage(payload, next);
  }

  if (next.state === 'verification_page') {
    return createStep6SuccessResult(next, {
      via: 'phone_login_submit',
      loginVerificationRequestedAt: phoneSubmittedAt,
    });
  }

  if (next.state === 'oauth_consent_page') {
    return createStep6SuccessResult(next, {
      via: 'phone_login_consent',
      loginVerificationBypassed: true,
    });
  }

  if (next.state === 'add_phone_page') {
    return handleStep6AddPhoneTransition('phone_login_add_phone', phoneSubmittedAt);
  }

  if (next.state === 'login_timeout_error_page') {
    return await createStep6LoginTimeoutRecoverableResult(
      'login_timeout_error_page',
      next,
      '手机号提交后进入登录超时报错页。'
    );
  }

  return createStep6RecoverableResult('phone_login_no_transition', next, {
    message: `提交手机号后未进入密码页（当前：${getLoginAuthStateLabel(next)}）。URL: ${next.url || location.href}`,
  });
}

async function step6LoginFromEmailPage(payload, snapshot) {
  const loginIdentifier = payload?.loginIdentifier || payload?.email || payload?.phone || '';
  const currentSnapshot = normalizeStep6Snapshot(snapshot || inspectLoginAuthState());
  const emailInput = currentSnapshot.emailInput || getLoginEmailInput();
  if (!emailInput) {
    throw new Error('在登录页未找到邮箱输入框。URL: ' + location.href);
  }

  if ((emailInput.value || '').trim() !== loginIdentifier) {
    await humanPause(500, 1400);
    fillInput(emailInput, loginIdentifier);
    log('步骤 7：已填写登录凭据（邮箱或手机号）');
  } else {
    log('步骤 7：登录凭据已在输入框中，准备提交...');
  }

  await sleep(500);
  const emailSubmittedAt = Date.now();
  await triggerLoginSubmitAction(currentSnapshot.submitButton, emailInput);
  log('步骤 7：已提交邮箱');

  const transition = await waitForStep6EmailSubmitTransition(emailSubmittedAt);
  if (transition.action === 'done') {
    log('步骤 7：已进入登录验证码页面。', 'ok');
    return transition.result;
  }
  if (transition.action === 'recoverable') {
    log(`步骤 7：${transition.result.message || '提交邮箱后仍未进入目标页面，准备重新执行步骤 7。'}`, 'warn');
    return transition.result;
  }
  if (transition.action === 'password') {
    return step6LoginFromPasswordPage(payload, transition.snapshot);
  }

  return createStep6RecoverableResult('email_submit_unknown', normalizeStep6Snapshot(inspectLoginAuthState()), {
    message: '提交邮箱后未得到可用的下一步状态。',
  });
}

async function step6LoginFromAccountPicker(payload) {
  const phone = payload?.phone || '';
  const email = payload?.email || '';
  const cards = findAccountPickerCards();
  if (!cards.length) {
    throw new Error('账号选择页未找到任何账号卡片。URL: ' + location.href);
  }

  // Decide: does any card represent the identifier we want to log in as?
  // Match by digit-only phone (page may render with spaces/parentheses/hyphens) or by email.
  const myPhoneDigits = normalizeAccountIdentifierDigits(phone);
  const myEmailLower = String(email || '').trim().toLowerCase();
  let targetCard = null;
  for (const card of cards) {
    const cardText = (card.textContent || '').trim();
    if (myPhoneDigits && myPhoneDigits.length >= 6) {
      const cardDigits = normalizeAccountIdentifierDigits(cardText);
      if (cardDigits.includes(myPhoneDigits) || myPhoneDigits.includes(cardDigits)) {
        targetCard = card;
        break;
      }
    }
    if (!targetCard && myEmailLower && cardText.toLowerCase().includes(myEmailLower)) {
      targetCard = card;
      break;
    }
  }

  if (targetCard) {
    const cardText = (targetCard.textContent || '').trim().slice(0, 40);
    log(`步骤 7：账号选择页命中本次注册账号"${cardText}"，直接点击登录...`);
    await humanPause(200, 500);
    simulateClick(targetCard);
  } else {
    const switchTrigger = findAccountPickerSwitchTrigger();
    if (!switchTrigger) {
      const cardSummary = cards.map(c => (c.textContent || '').trim().slice(0, 30)).join(' | ');
      throw new Error(`步骤 7：账号选择页中没有本次注册的账号（候选：${cardSummary}），且未找到“登录至另一个帐户”入口。URL: ${location.href}`);
    }
    log(`步骤 7：账号选择页中没有本次注册的账号（${phone || email || '未知'}），点击“登录至另一个帐户”切换登录入口...`, 'warn');
    await humanPause(200, 500);
    simulateClick(switchTrigger);
  }

  await sleep(1500);
  const next = normalizeStep6Snapshot(await waitForKnownLoginAuthState(15000));

  if (next.state === 'password_page') return step6LoginFromPasswordPage(payload, next);
  if (next.state === 'verification_page') return createStep6SuccessResult(next, { via: 'account_picker' });
  if (next.state === 'phone_login_page') return step6LoginFromPhonePage(payload, next);
  if (next.state === 'email_page') return step6LoginFromEmailPage(payload, next);
  if (next.state === 'add_email_page') return handleStep7AddEmailTransition('account_picker_add_email', null);
  if (next.state === 'oauth_consent_page') return createStep6SuccessResult(next, { via: 'account_picker', loginVerificationBypassed: true });

  return createStep6RecoverableResult('account_picker_no_transition', next, {
    message: `账号选择后未进入已知页面状态（${getLoginAuthStateLabel(next)}）。URL: ${next.url || location.href}`,
  });
}

async function step6_login(payload) {
  const loginIdentifier = payload?.loginIdentifier || payload?.email || payload?.phone || null;
  if (!loginIdentifier) throw new Error('登录时缺少登录凭据（邮箱或手机号）。');

  const { email } = payload;
  log(`步骤 7：正在使用 ${loginIdentifier} 登录...`);

  const snapshot = normalizeStep6Snapshot(await waitForKnownLoginAuthState(15000));

  if (snapshot.state === 'verification_page') {
    log('步骤 7：登录验证码页面已就绪。', 'ok');
    return createStep6SuccessResult(snapshot, { via: 'already_on_verification_page' });
  }

  if (snapshot.state === 'login_timeout_error_page') {
    log('步骤 7：检测到登录超时报错，准备重新执行步骤 7。', 'warn');
    return await createStep6LoginTimeoutRecoverableResult(
      'login_timeout_error_page',
      snapshot,
      '当前页面处于登录超时报错页。'
    );
  }

  if (snapshot.state === 'email_page') {
    if (payload.phone) {
      const phoneTrigger = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))
        .find(el => isVisibleElement(el) && PHONE_SIGNUP_TOGGLE_PATTERN.test(getActionText(el)));
      if (phoneTrigger) {
        log('步骤 7：检测到"使用电话号码继续"按钮，切换到手机号登录模式...');
        await humanPause(300, 800);
        phoneTrigger.click();
        // After clicking the phone toggle, the page may briefly still expose the old
        // email input. Poll specifically for a non-email-page state so we don't
        // incorrectly fall into the email handler again.
        const start = Date.now();
        const PHONE_TOGGLE_WAIT_MS = 15000;
        let phoneSnapshot = normalizeStep6Snapshot(inspectLoginAuthState());
        while (Date.now() - start < PHONE_TOGGLE_WAIT_MS) {
          throwIfStopped();
          phoneSnapshot = normalizeStep6Snapshot(inspectLoginAuthState());
          if (phoneSnapshot.state === 'phone_login_page'
            || phoneSnapshot.state === 'password_page'
            || phoneSnapshot.state === 'verification_page'
            || phoneSnapshot.state === 'add_phone_page'
            || phoneSnapshot.state === 'oauth_consent_page'
            || phoneSnapshot.state === 'add_email_page'
            || phoneSnapshot.state === 'login_timeout_error_page') {
            break;
          }
          await sleep(250);
        }
        log(`步骤 7：切换后的页面状态 = ${phoneSnapshot?.state} (等待 ${Math.round((Date.now() - start) / 1000)}s)`);
        if (phoneSnapshot.state === 'phone_login_page') {
          return step6LoginFromPhonePage(payload, phoneSnapshot);
        }
        if (phoneSnapshot.state === 'password_page') {
          return step6LoginFromPasswordPage(payload, phoneSnapshot);
        }
        if (phoneSnapshot.state === 'verification_page') {
          return createStep6SuccessResult(phoneSnapshot, { via: 'email_page_phone_toggle' });
        }
        if (phoneSnapshot.state === 'add_phone_page') {
          return handleStep6AddPhoneTransition('email_page_phone_toggle_add_phone', null);
        }
        if (phoneSnapshot.state === 'add_email_page') {
          return handleStep7AddEmailTransition('email_page_phone_toggle_add_email', null);
        }
        // Page still looks like email page after the toggle (rare) — try our best: treat
        // any tel-like input as a phone input and route through the phone handler.
        const telInput = document.querySelector('input[type="tel"]:not([maxlength="6"])');
        if (telInput && isVisibleElement(telInput)) {
          log('步骤 7：切换后未检测到 phone_login_page 状态，但页面存在 tel 输入框，强制走手机号登录处理。', 'warn');
          return step6LoginFromPhonePage(payload, phoneSnapshot);
        }
        log(`步骤 7：切换后页面仍判定为 ${phoneSnapshot.state}，回退到邮箱登录处理。`, 'warn');
        return step6LoginFromEmailPage(payload, phoneSnapshot);
      }
    }
    return step6LoginFromEmailPage(payload, snapshot);
  }

  if (snapshot.state === 'password_page') {
    return step6LoginFromPasswordPage(payload, snapshot);
  }

  if (snapshot.state === 'account_picker_page') {
    return step6LoginFromAccountPicker(payload);
  }

  if (snapshot.state === 'phone_login_page') {
    return step6LoginFromPhonePage(payload, snapshot);
  }

  if (snapshot.state === 'add_phone_page') {
    return handleStep6AddPhoneTransition('already_on_add_phone_page', null);
  }

  if (snapshot.state === 'add_email_page') {
    return handleStep7AddEmailTransition('already_on_add_email_page', null);
  }

  throwForStep6FatalState(snapshot);
  throw new Error(`无法识别当前登录页面状态。URL: ${snapshot?.url || location.href}`);
}

// ============================================================
// Step 9: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('步骤 9：正在查找 OAuth 同意页的“继续”按钮...');

  const continueBtn = await prepareStep8ContinueButton();

  const rect = getSerializableRect(continueBtn);
  log('步骤 9：已找到“继续”按钮并准备好调试器点击坐标。');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

function getStep8State() {
  const continueBtn = getPrimaryContinueButton();
  const retryState = getCurrentAuthRetryPageState('auth');
  const state = {
    url: location.href,
    consentPage: isOAuthConsentPage(),
    consentReady: isStep8Ready(),
    verificationPage: isVerificationPageStillVisible(),
    addPhonePage: isAddPhonePageReady(),
    retryPage: Boolean(retryState),
    retryEnabled: Boolean(retryState?.retryEnabled),
    retryTitleMatched: Boolean(retryState?.titleMatched),
    retryDetailMatched: Boolean(retryState?.detailMatched),
    maxCheckAttemptsBlocked: Boolean(retryState?.maxCheckAttemptsBlocked),
    buttonFound: Boolean(continueBtn),
    buttonEnabled: isButtonEnabled(continueBtn),
    buttonText: continueBtn ? getActionText(continueBtn) : '',
  };

  if (continueBtn) {
    try {
      state.rect = getSerializableRect(continueBtn);
    } catch {
      state.rect = null;
    }
  }

  return state;
}

async function step8_triggerContinue(payload = {}) {
  const strategy = payload?.strategy || 'requestSubmit';
  const continueBtn = await prepareStep8ContinueButton({
    findTimeoutMs: payload?.findTimeoutMs,
    enabledTimeoutMs: payload?.enabledTimeoutMs,
  });
  const form = continueBtn.form || continueBtn.closest('form');

  switch (strategy) {
    case 'requestSubmit':
      if (!form || typeof form.requestSubmit !== 'function') {
        throw new Error('“继续”按钮当前不在可提交的 form 中，无法使用 requestSubmit。URL: ' + location.href);
      }
      form.requestSubmit(continueBtn);
      break;
    case 'nativeClick':
      continueBtn.click();
      break;
    case 'dispatchClick':
      simulateClick(continueBtn);
      break;
    default:
      throw new Error(`未知的 Step 9 触发策略：${strategy}`);
  }

  log(`Step 9: continue button triggered via ${strategy}.`);
  return {
    strategy,
    ...getStep8State(),
  };
}

async function prepareStep8ContinueButton(options = {}) {
  const {
    findTimeoutMs = 10000,
    enabledTimeoutMs = 8000,
  } = options;

  const continueBtn = await findContinueButton(findTimeoutMs);
  await waitForButtonEnabled(continueBtn, enabledTimeoutMs);

  await humanPause(250, 700);
  continueBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
  continueBtn.focus();
  await waitForStableButtonRect(continueBtn);
  return continueBtn;
}

async function findContinueButton(timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isAddPhonePageReady()) {
      await handleAddPhoneVerificationFlow();
      await sleep(500);
      continue;
    }
    const button = getPrimaryContinueButton();
    if (button && isStep8Ready()) {
      return button;
    }
    await sleep(150);
  }

  throw new Error('在 OAuth 同意页未找到“继续”按钮，或页面尚未进入授权同意状态。URL: ' + location.href);
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('“继续”按钮长时间不可点击。URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

async function waitForStableButtonRect(button, timeout = 1500) {
  let previous = null;
  let stableSamples = 0;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const rect = button?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const snapshot = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };

      if (
        previous
        && Math.abs(snapshot.left - previous.left) < 1
        && Math.abs(snapshot.top - previous.top) < 1
        && Math.abs(snapshot.width - previous.width) < 1
        && Math.abs(snapshot.height - previous.height) < 1
      ) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          return;
        }
      } else {
        stableSamples = 0;
      }

      previous = snapshot;
    }

    await sleep(80);
  }
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('滚动后“继续”按钮没有可点击尺寸。URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

function getStep5DirectCompletionPayload({ isAgeMode = false } = {}) {
  const payload = {
    skippedPostSubmitCheck: true,
    directProceedToStep6: true,
  };
  if (isAgeMode) {
    payload.ageMode = true;
  }
  return payload;
}

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('未提供姓名数据。');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('未提供生日或年龄数据。');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`步骤 5：正在填写姓名：${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('未找到姓名输入框。URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`步骤 5：姓名已填写：${fullName}`);

  let birthdayMode = false;
  let ageInput = null;
  let yearSpinner = null;
  let monthSpinner = null;
  let daySpinner = null;
  let hiddenBirthday = null;
  let yearReactSelect = null;
  let monthReactSelect = null;
  let dayReactSelect = null;
  let visibleAgeInput = false;
  let visibleBirthdaySpinners = false;
  let visibleBirthdaySelects = false;

  for (let i = 0; i < 100; i++) {
    yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');
    yearReactSelect = findBirthdayReactAriaSelect('年');
    monthReactSelect = findBirthdayReactAriaSelect('月');
    dayReactSelect = findBirthdayReactAriaSelect('天');

    visibleAgeInput = Boolean(ageInput && isVisibleElement(ageInput));
    visibleBirthdaySpinners = Boolean(
      yearSpinner
      && monthSpinner
      && daySpinner
      && isVisibleElement(yearSpinner)
      && isVisibleElement(monthSpinner)
      && isVisibleElement(daySpinner)
    );
    visibleBirthdaySelects = Boolean(
      yearReactSelect?.button
      && monthReactSelect?.button
      && dayReactSelect?.button
      && isVisibleElement(yearReactSelect.button)
      && isVisibleElement(monthReactSelect.button)
      && isVisibleElement(dayReactSelect.button)
    );

    if (visibleAgeInput) break;
    if (visibleBirthdaySpinners || visibleBirthdaySelects) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('检测到生日字段，但未提供生日数据。');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const yearReactSelect = findBirthdayReactAriaSelect('年');
    const monthReactSelect = findBirthdayReactAriaSelect('月');
    const dayReactSelect = findBirthdayReactAriaSelect('天');

    if (yearReactSelect?.nativeSelect && monthReactSelect?.nativeSelect && dayReactSelect?.nativeSelect) {
      const desiredDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const hiddenBirthday = document.querySelector('input[name="birthday"]');

      log('步骤 5：检测到 React Aria 下拉生日字段，正在填写生日...');
      await humanPause(450, 1100);
      await setReactAriaBirthdaySelect(yearReactSelect, year);
      await humanPause(250, 650);
      await setReactAriaBirthdaySelect(monthReactSelect, month);
      await humanPause(250, 650);
      await setReactAriaBirthdaySelect(dayReactSelect, day);

      if (hiddenBirthday) {
        const start = Date.now();
        while (Date.now() - start < 2000) {
          if ((hiddenBirthday.value || '') === desiredDate) break;
          await sleep(100);
        }

        if ((hiddenBirthday.value || '') !== desiredDate) {
          throw new Error(`生日值未成功写入页面。期望 ${desiredDate}，实际 ${(hiddenBirthday.value || '空')}。`);
        }
      }

      log(`步骤 5：React Aria 生日已填写：${desiredDate}`);
    }

    if (yearSpinner && monthSpinner && daySpinner) {
      log('步骤 5：检测到生日字段，正在填写生日...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`步骤 5：生日已填写：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`步骤 5：已设置隐藏生日输入框：${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('检测到年龄字段，但未提供年龄数据。');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`步骤 5：年龄已填写：${resolvedAge}`);
  } else {
    throw new Error('未找到生日或年龄输入项。URL: ' + location.href);
  }
  // 韩国IP判断勾选框""I agree"
  const allConsentCheckbox = findStep5AllConsentCheckbox();

  if (allConsentCheckbox) {
    if (!isStep5CheckboxChecked(allConsentCheckbox)) {
      const checkboxLabel = allConsentCheckbox.closest('label');
      await humanPause(500, 1500);
      if (checkboxLabel && isVisibleElement(checkboxLabel)) {
        simulateClick(checkboxLabel);
      } else {
        simulateClick(allConsentCheckbox);
      }
      await sleep(250);

      if (!isStep5CheckboxChecked(allConsentCheckbox)) {
        allConsentCheckbox.click();
        await sleep(250);
      }

      if (!isStep5CheckboxChecked(allConsentCheckbox)) {
        throw new Error('未能勾选 “I agree to all of the following” 复选框。');
      }

      log('步骤 5：已勾选 “I agree to all of the following”。');
    } else {
      log('步骤 5：“I agree to all of the following” 已勾选，跳过。');
    }
  }


  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);
  if (!completeBtn) {
    throw new Error('未找到“完成帐户创建”按钮。URL: ' + location.href);
  }

  const isAgeMode = !birthdayMode && Boolean(ageInput);
  if (isAgeMode) {
    log('步骤 5：当前为年龄输入模式，点击”完成帐户创建”后将直接完成当前步骤。', 'warn');
  }

  await humanPause(500, 1300);
  simulateClick(completeBtn);

  const completionPayload = getStep5DirectCompletionPayload({ isAgeMode });
  reportComplete(5, completionPayload);

  if (isAgeMode) {
    log('步骤 5：年龄模式已点击“完成帐户创建”，当前步骤直接完成，不再等待页面结果。', 'warn');
    return completionPayload;
  }

  log('步骤 5：已点击“完成帐户创建”，当前步骤直接完成，不再等待页面结果。');
  return completionPayload;
}
