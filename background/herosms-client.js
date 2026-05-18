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

    return { urlFor };
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
