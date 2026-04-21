const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

function extractFunctionOccurrence(name, occurrence = 1) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  let searchFrom = 0;

  for (let count = 0; count < occurrence; count += 1) {
    start = markers
      .map((marker) => source.indexOf(marker, searchFrom))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? -1;
    if (start < 0) {
      throw new Error(`missing function ${name} occurrence ${occurrence}`);
    }
    searchFrom = start + 1;
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }

  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function extractFunction(name) {
  return extractFunctionOccurrence(name, 1);
}

test('verification visibility text fallback should not treat password retry page as verification page', () => {
  const api = new Function(`
const VERIFICATION_PAGE_PATTERN = /check\\s+your\\s+inbox|we\\s+emailed|resend/i;
const document = {
  querySelector() {
    return null;
  },
};

function getCurrentAuthRetryPageState(flow) {
  if (flow === 'signup_password') {
    return { retryEnabled: true };
  }
  return null;
}

function getVerificationCodeTarget() {
  return null;
}

function findResendVerificationCodeTrigger() {
  return null;
}

function isEmailVerificationPage() {
  return false;
}

function getPageTextSnapshot() {
  return 'Check your inbox and resend email if needed';
}

${extractFunction('isVerificationPageStillVisible')}

return {
  run() {
    return isVerificationPageStillVisible();
  },
};
`)();

  assert.equal(api.run(), false);
});

test('signup verification state should prioritize retry error page over verification visibility', () => {
  const api = new Function(`
function isStep5Ready() {
  return false;
}

function isVerificationPageStillVisible() {
  return true;
}

function isSignupPasswordErrorPage() {
  return true;
}

function getSignupPasswordTimeoutErrorPageState() {
  return { retryButton: { textContent: 'Try again' } };
}

function isSignupEmailAlreadyExistsPage() {
  return false;
}

function getSignupPasswordInput() {
  return null;
}

function getSignupPasswordSubmitButton() {
  return null;
}

${extractFunction('inspectSignupVerificationState')}

return {
  run() {
    return inspectSignupVerificationState();
  },
};
`)();

  assert.deepStrictEqual(api.run(), {
    state: 'error',
    retryButton: { textContent: 'Try again' },
    userAlreadyExistsBlocked: false,
  });
});

test('signup verification state treats email-verification retry page as error instead of verification', () => {
  const api = new Function(`
const location = {
  pathname: '/email-verification',
};

function getAuthTimeoutErrorPageState(options) {
  return options.pathPatterns.some((pattern) => pattern.test(location.pathname))
    ? { retryButton: { textContent: 'Try again' } }
    : null;
}

function isStep5Ready() {
  return false;
}

function isVerificationPageStillVisible() {
  return true;
}

function isSignupEmailAlreadyExistsPage() {
  return false;
}

function getSignupPasswordInput() {
  return null;
}

function getSignupPasswordSubmitButton() {
  return null;
}

${extractFunction('getSignupAuthRetryPathPatterns')}
${extractFunction('getSignupPasswordTimeoutErrorPageState')}
${extractFunctionOccurrence('isSignupPasswordErrorPage', 1)}
${extractFunction('inspectSignupVerificationState')}

return {
  run() {
    return inspectSignupVerificationState();
  },
};
`)();

  assert.deepStrictEqual(api.run(), {
    state: 'error',
    retryButton: { textContent: 'Try again' },
    userAlreadyExistsBlocked: false,
  });
});

test('step 7 restart signal detects login timeout page without legacy matcher helper', () => {
  const api = new Function(`
const location = {
  href: 'https://auth.openai.com/log-in',
  pathname: '/log-in',
};

function isLoginPage() {
  return true;
}

function getAuthTimeoutErrorPageState(options) {
  return options.pathPatterns.some((pattern) => pattern.test(location.pathname))
    ? { retryButton: { textContent: 'Try again' }, retryEnabled: true }
    : null;
}

${extractFunction('getLoginTimeoutErrorPageState')}
${extractFunction('buildStep7RestartFromStep6Marker')}
${extractFunction('getStep7RestartFromStep6Signal')}

return {
  run() {
    return getStep7RestartFromStep6Signal();
  },
};
`)();

  assert.deepStrictEqual(api.run(), {
    error: 'STEP7_RESTART_FROM_STEP6::login_timeout_error_page::https://auth.openai.com/log-in',
    restartFromStep6: true,
    reason: 'login_timeout_error_page',
    url: 'https://auth.openai.com/log-in',
  });
});
