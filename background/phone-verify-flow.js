(function attachPhoneVerifyFlow(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPagePhoneVerifyFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createPhoneVerifyFlowModule() {
  const COUNTRY_CODES = Object.freeze({ CHILE: 151, BRAZIL: 73, UK: 16 });
  const SERVICE_OPENAI = 'dr';
  const STATUS_CODES = Object.freeze({ SMS_SENT: 1, REQUEST_RESEND: 3, COMPLETE: 6, CANCEL: 8 });
  const DEFAULT_COUNTRY_SEQUENCE = Object.freeze([
    COUNTRY_CODES.CHILE,
    COUNTRY_CODES.BRAZIL,
    COUNTRY_CODES.UK,
  ]);
  const DEFAULT_POLL_INTERVAL_MS = 5000;
  const DEFAULT_TIMEOUT_MS = 120000;
  const DEFAULT_MAX_RESEND_ATTEMPTS = 2;

  class PhoneVerifyFlowError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'PhoneVerifyFlowError';
      this.code = code || 'PHONE_VERIFY_FLOW_ERROR';
    }
  }

  class NewNumberRequiredError extends PhoneVerifyFlowError {
    constructor(reason) {
      super(reason || 'new number required', 'NEW_NUMBER_REQUIRED');
      this.name = 'NewNumberRequiredError';
      this.reason = reason || 'NEW_NUMBER_REQUIRED';
    }
  }

  class PollTimeoutError extends NewNumberRequiredError {
    constructor(timeoutMs) {
      super('POLL_TIMEOUT');
      this.name = 'PollTimeoutError';
      this.code = 'POLL_TIMEOUT';
      this.timeoutMs = timeoutMs;
    }
  }

  function createPhoneVerifyFlow(options = {}) {
    const herosmsClient = options.herosmsClient;
    if (!herosmsClient
      || typeof herosmsClient.getNumber !== 'function'
      || typeof herosmsClient.getStatus !== 'function'
      || typeof herosmsClient.setStatus !== 'function') {
      throw new PhoneVerifyFlowError('herosmsClient with getNumber/getStatus/setStatus is required', 'MISSING_HEROSMS_CLIENT');
    }

    const countrySequence = (options.countrySequence || options.countries || DEFAULT_COUNTRY_SEQUENCE).slice();
    const service = options.service || SERVICE_OPENAI;
    const maxPricePerNumber = Number.isFinite(Number(options.maxPricePerNumber)) && Number(options.maxPricePerNumber) > 0
      ? Number(options.maxPricePerNumber)
      : null;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxResendAttempts = Number.isFinite(options.maxResendAttempts) ? options.maxResendAttempts : DEFAULT_MAX_RESEND_ATTEMPTS;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const logger = options.logger || null;

    let currentActivation = null;

    function log(level, message, data) {
      if (logger && typeof logger[level] === 'function') logger[level](message, data);
    }

    function cloneActivation(activation = currentActivation) {
      return activation ? { ...activation } : null;
    }

    function isNoNumbersResult(result) {
      return result === 'NO_NUMBERS'
        || (result && (result.code === 'NO_NUMBERS' || result.status === 'NO_NUMBERS'));
    }

    function isNoNumbersError(error) {
      return error && (error.code === 'NO_NUMBERS' || error.name === 'NoNumbersError');
    }

    function extractCode(status) {
      if (!status) return null;
      if (typeof status === 'string' && status.startsWith('STATUS_OK:')) return status.slice('STATUS_OK:'.length);
      if ((status.status === 'ok' || status.status === 'STATUS_OK') && status.code) return String(status.code);
      return null;
    }

    function isWaitingStatus(status) {
      if (!status) return false;
      if (typeof status === 'string') return status === 'STATUS_WAIT_CODE' || status.startsWith('STATUS_WAIT_RETRY:');
      return status.status === 'wait' || status.status === 'wait_retry'
        || status.status === 'STATUS_WAIT_CODE' || status.status === 'STATUS_WAIT_RETRY';
    }

    function terminalReason(status) {
      if (!status) return 'UNKNOWN_STATUS';
      if (typeof status === 'string') {
        if (status === 'STATUS_CANCEL') return 'STATUS_CANCEL';
        if (!status.startsWith('STATUS_WAIT_') && !status.startsWith('STATUS_OK:')) return status;
        return null;
      }
      const value = status.status;
      if (!value || value === 'wait' || value === 'wait_retry' || value === 'ok'
        || value === 'STATUS_WAIT_CODE' || value === 'STATUS_WAIT_RETRY' || value === 'STATUS_OK') {
        return null;
      }
      return String(value).toUpperCase();
    }

    async function abandonCurrentActivation(reason) {
      if (!currentActivation || !currentActivation.id) return null;
      const activation = currentActivation;
      currentActivation = null;
      try {
        await herosmsClient.setStatus(activation.id, STATUS_CODES.CANCEL);
      } catch (error) {
        // HTTP 409 means activation is already in a terminal state — treat as cancelled
        if (error?.code !== 'HTTP_409') {
          if (!currentActivation) currentActivation = activation;
          throw error;
        }
      }
      activation.status = 'cancelled';
      activation.cancelReason = reason || null;
      return cloneActivation(activation);
    }

    async function isCountryWithinPriceLimit(country) {
      if (!maxPricePerNumber) return { allowed: true };
      if (typeof herosmsClient.getPrices !== 'function') return { allowed: true, skipped: true };
      try {
        const priceResult = await herosmsClient.getPrices({ service, country });
        const cost = Number(priceResult?.cost);
        if (Number.isFinite(cost) && cost > maxPricePerNumber) {
          log('warn', 'HeroSMS country price exceeds limit', { country, cost, maxPricePerNumber });
          return { allowed: false, cost };
        }
        return { allowed: true, cost: Number.isFinite(cost) ? cost : null };
      } catch (error) {
        log('warn', 'HeroSMS getPrices failed; relying on server-side maxPrice', { country, error });
        return { allowed: true, skipped: true };
      }
    }

    async function requestNumber() {
      if (currentActivation && currentActivation.id) {
        await abandonCurrentActivation('REPLACED_BY_REQUEST_NUMBER');
      }

      let countries = countrySequence;
      if (typeof herosmsClient.getCountries === 'function') {
        try {
          const dynamicCountries = await herosmsClient.getCountries(service);
          if (dynamicCountries && dynamicCountries.length > 0) {
            countries = dynamicCountries;
            log('info', 'HeroSMS dynamic countries loaded', { count: countries.length, service });
          }
        } catch (error) {
          log('warn', 'HeroSMS getCountries failed, using static fallback', { service, error });
        }
      }

      let lastNoNumbersError = null;
      let priceExceededCountries = 0;
      let attemptedCountries = 0;
      for (const country of countries) {
        const priceCheck = await isCountryWithinPriceLimit(country);
        if (!priceCheck.allowed) {
          priceExceededCountries += 1;
          continue;
        }

        attemptedCountries += 1;
        try {
          const result = await herosmsClient.getNumber({
            service,
            country,
            ...(maxPricePerNumber ? { maxPrice: maxPricePerNumber } : {}),
          });
          if (isNoNumbersResult(result)) {
            lastNoNumbersError = new NewNumberRequiredError('NO_NUMBERS');
            continue;
          }
          if (!result || result.id === undefined || result.phone === undefined) {
            throw new PhoneVerifyFlowError('getNumber returned invalid activation', 'INVALID_ACTIVATION');
          }
          currentActivation = {
            id: String(result.id),
            phone: String(result.phone),
            country,
            service,
            resendCount: 0,
            status: 'active',
          };
          return cloneActivation();
        } catch (error) {
          if (!isNoNumbersError(error)) throw error;
          lastNoNumbersError = error;
          log('warn', 'HeroSMS country has no numbers, trying fallback', { country, error });
        }
      }
      if (attemptedCountries === 0 && priceExceededCountries > 0) {
        throw new NewNumberRequiredError('PRICE_EXCEEDED');
      }
      throw new NewNumberRequiredError(lastNoNumbersError ? 'NO_NUMBERS' : 'NO_COUNTRIES');
    }

    function getCurrentActivation() {
      return cloneActivation();
    }

    async function pollForCode() {
      if (!currentActivation || !currentActivation.id) throw new NewNumberRequiredError('NO_CURRENT_ACTIVATION');
      const activation = currentActivation;
      const startedAt = now();
      let iteration = 0;
      log('info', `[pollForCode] 启动 id=${activation.id} timeoutMs=${timeoutMs} pollIntervalMs=${pollIntervalMs}`);
      console.log('[PhoneVerifyFlow][pollForCode] start', { id: activation.id, timeoutMs, pollIntervalMs });
      while (true) {
        if (currentActivation !== activation) throw new NewNumberRequiredError('ACTIVATION_CHANGED');
        iteration += 1;
        const iterStartedAt = now();
        let status;
        try {
          status = await herosmsClient.getStatus(activation.id);
        } catch (fetchErr) {
          const elapsed = now() - startedAt;
          const errMsg = fetchErr?.message || String(fetchErr);
          log('warn', `[pollForCode] #${iteration} getStatus 异常（已过 ${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s）：${errMsg}`);
          console.warn('[PhoneVerifyFlow][pollForCode] getStatus threw', { iteration, elapsed, timeoutMs, error: errMsg });
          if (elapsed >= timeoutMs) throw new PollTimeoutError(timeoutMs);
          await sleep(pollIntervalMs);
          continue;
        }
        const elapsed = now() - startedAt;
        const statusSummary = typeof status === 'string' ? status : (status?.status || JSON.stringify(status));
        log('info', `[pollForCode] #${iteration} status=${statusSummary} 已过 ${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s`);
        console.log('[PhoneVerifyFlow][pollForCode] iter', { iteration, status, elapsed, timeoutMs });
        if (currentActivation !== activation) throw new NewNumberRequiredError('ACTIVATION_CHANGED');
        const code = extractCode(status);
        if (code) {
          activation.status = 'code_received';
          activation.code = code;
          return code;
        }
        if (isWaitingStatus(status)) {
          if (elapsed >= timeoutMs) {
            log('warn', `[pollForCode] 达到 timeoutMs=${timeoutMs}，抛 PollTimeoutError`);
            throw new PollTimeoutError(timeoutMs);
          }
          await sleep(pollIntervalMs);
          continue;
        }
        const reason = terminalReason(status);
        activation.status = reason || 'unknown';
        log('warn', `[pollForCode] 终态状态 reason=${reason || 'UNKNOWN_STATUS'}，抛 NewNumberRequiredError`);
        throw new NewNumberRequiredError(reason || 'UNKNOWN_STATUS');
      }
    }

    async function resendCurrentNumber() {
      if (!currentActivation || !currentActivation.id) throw new NewNumberRequiredError('NO_CURRENT_ACTIVATION');
      const activation = currentActivation;
      if (activation.resendCount >= maxResendAttempts) {
        return {
          resent: false,
          requiresNewNumber: true,
          reason: 'RESEND_LIMIT',
          resendCount: activation.resendCount,
        };
      }
      await herosmsClient.setStatus(activation.id, STATUS_CODES.REQUEST_RESEND);
      if (currentActivation !== activation) {
        return {
          resent: false,
          requiresNewNumber: true,
          reason: 'ACTIVATION_CHANGED',
          resendCount: activation.resendCount,
        };
      }
      activation.resendCount += 1;
      activation.status = 'resend_requested';
      return { resent: true, requiresNewNumber: false, resendCount: activation.resendCount };
    }

    async function replaceNumber(reason) {
      await abandonCurrentActivation(reason || 'REPLACE_NUMBER');
      await requestNumber();
      currentActivation.replaceReason = reason || null;
      return cloneActivation();
    }

    async function complete() {
      if (!currentActivation || !currentActivation.id) return { completed: false };
      const activation = currentActivation;
      currentActivation = null;
      try {
        await herosmsClient.setStatus(activation.id, STATUS_CODES.COMPLETE);
      } catch (error) {
        if (!currentActivation) currentActivation = activation;
        throw error;
      }
      activation.status = 'complete';
      return { completed: true, activation: cloneActivation(activation) };
    }

    async function cancel(reason) {
      const activation = await abandonCurrentActivation(reason || null);
      return activation ? { cancelled: true, activation } : { cancelled: false };
    }

    return {
      requestNumber,
      getCurrentActivation,
      pollForCode,
      resendCurrentNumber,
      replaceNumber,
      complete,
      cancel,
    };
  }

  return {
    createPhoneVerifyFlow,
    DEFAULT_COUNTRY_SEQUENCE,
    COUNTRY_CODES,
    SERVICE_OPENAI,
    STATUS_CODES,
    DEFAULT_MAX_RESEND_ATTEMPTS,
    PhoneVerifyFlowError,
    NewNumberRequiredError,
    PollTimeoutError,
  };
});
