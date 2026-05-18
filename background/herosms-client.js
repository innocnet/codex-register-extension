(function attachHerosmsClient(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageHerosmsClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHerosmsClientModule() {
  const DEFAULT_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const DEFAULT_TIMEOUT_MS = 30000;

  class HerosmsError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'HerosmsError';
      this.code = code || 'UNKNOWN';
    }
  }
  class NoNumbersError extends HerosmsError { constructor(msg='NO_NUMBERS'){ super(msg,'NO_NUMBERS'); this.name='NoNumbersError'; } }
  class NoBalanceError extends HerosmsError { constructor(msg='NO_BALANCE'){ super(msg,'NO_BALANCE'); this.name='NoBalanceError'; } }
  class AuthenticationError extends HerosmsError { constructor(msg='BAD_KEY'){ super(msg,'BAD_KEY'); this.name='AuthenticationError'; } }
  class BannedError extends HerosmsError {
    constructor(msg, until) {
      super(msg || 'BANNED', 'BANNED');
      this.name = 'BannedError';
      this.until = until || 0;
    }
  }

  function buildUrl(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function createHerosmsClient(options = {}) {
    const apiKey = String(options.apiKey || '').trim();
    const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    if (!apiKey) throw new HerosmsError('apiKey is required', 'BAD_KEY');
    if (!fetchImpl) throw new HerosmsError('fetch implementation missing', 'NO_FETCH');

    function urlFor(action, extra = {}) {
      return buildUrl(baseUrl, { api_key: apiKey, action, ...extra });
    }

    async function callApi(action, extra = {}) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(urlFor(action, extra), controller ? { signal: controller.signal } : undefined);
        const text = (await response.text()).trim();
        return text;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function getNumber({ service, country, maxPrice, operator } = {}) {
      const text = await callApi('getNumber', { service, country, maxPrice, operator });
      if (text.startsWith('ACCESS_NUMBER:')) {
        const [, id, phone] = text.split(':');
        return { id: String(id), phone: String(phone) };
      }
      throw parseError(text);
    }

    async function getStatus(id) {
      const text = await callApi('getStatus', { id });
      if (text === 'STATUS_WAIT_CODE') return { status: 'wait' };
      if (text === 'STATUS_CANCEL') return { status: 'cancel' };
      if (text.startsWith('STATUS_OK:')) {
        return { status: 'ok', code: text.slice('STATUS_OK:'.length) };
      }
      if (text.startsWith('STATUS_WAIT_RETRY:')) {
        return { status: 'wait_retry', lastCode: text.slice('STATUS_WAIT_RETRY:'.length) };
      }
      throw parseError(text);
    }

    const SET_STATUS_OK = new Set(['ACCESS_READY', 'ACCESS_RETRY_GET', 'ACCESS_ACTIVATION', 'ACCESS_CANCEL']);

    async function setStatus(id, status) {
      const text = await callApi('setStatus', { id, status });
      if (SET_STATUS_OK.has(text)) return;
      throw parseError(text);
    }

    function parseError(text) {
      if (!text) return new HerosmsError('empty response', 'EMPTY');
      if (text === 'NO_NUMBERS') return new NoNumbersError();
      if (text === 'NO_BALANCE') return new NoBalanceError();
      if (text === 'BAD_KEY') return new AuthenticationError();
      if (text.startsWith('BANNED:')) {
        const until = parseInt(text.split(':')[1] || '0', 10);
        return new BannedError(text, Number.isFinite(until) ? until : 0);
      }
      return new HerosmsError(text, text.toUpperCase());
    }

    return { urlFor, getNumber, getStatus, setStatus };
  }

  return {
    createHerosmsClient,
    HerosmsError,
    NoNumbersError,
    NoBalanceError,
    AuthenticationError,
    BannedError,
    DEFAULT_BASE_URL,
  };
});
