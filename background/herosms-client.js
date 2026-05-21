(function attachHerosmsClient(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageHerosmsClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHerosmsClientModule() {
  const DEFAULT_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const DEFAULT_TIMEOUT_MS = 30000;
  const COUNTRY_CODES = Object.freeze({ CHILE: 151, BRAZIL: 73, UK: 16 });
  const SERVICE_OPENAI = 'dr';
  const COUNTRIES_API_BASE = 'https://hero-sms.com/api/v1/left-menu/service';
  const STATUS_CODES = Object.freeze({ SMS_SENT: 1, REQUEST_RESEND: 3, COMPLETE: 6, CANCEL: 8 });

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
        if (response && response.ok === false) {
          throw new HerosmsError(`HTTP ${response.status}`, `HTTP_${response.status}`);
        }
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

    async function getBalance() {
      const text = await callApi('getBalance');
      if (text.startsWith('ACCESS_BALANCE:')) {
        return { balance: text.slice('ACCESS_BALANCE:'.length) };
      }
      throw parseError(text);
    }

    async function getPrices({ service, country } = {}) {
      const text = await callApi('getPrices', { service, country });
      if (!text) throw new HerosmsError('empty getPrices response', 'EMPTY');
      if (text === 'BAD_KEY' || text === 'NO_BALANCE' || text.startsWith('BANNED:')) {
        throw parseError(text);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        throw new HerosmsError(`getPrices: invalid JSON response: ${text}`, 'INVALID_RESPONSE');
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new HerosmsError('getPrices: empty parsed payload', 'INVALID_RESPONSE');
      }
      if (service !== undefined && country !== undefined) {
        const countryKey = String(country);
        const countryEntry = parsed[countryKey];
        if (!countryEntry || typeof countryEntry !== 'object') {
          throw new HerosmsError(`getPrices: no entry for country ${countryKey}`, 'MISSING_PRICE');
        }
        const entry = countryEntry[service];
        if (!entry || !Number.isFinite(Number(entry.cost))) {
          throw new HerosmsError(`getPrices: no price for service=${service} country=${countryKey}`, 'MISSING_PRICE');
        }
        return {
          cost: Number(entry.cost),
          count: Number.isFinite(Number(entry.count)) ? Number(entry.count) : 0,
          raw: parsed,
        };
      }
      return { raw: parsed };
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

    async function getCountries(service) {
      const svc = service || SERVICE_OPENAI;
      const url = `${COUNTRIES_API_BASE}/${svc}/countries?service=${svc}&page=1&size=50`;
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (response && response.ok === false) {
          throw new HerosmsError(`getCountries HTTP ${response.status}`, `HTTP_${response.status}`);
        }
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (_) {
          throw new HerosmsError(`getCountries: invalid JSON: ${text.slice(0, 80)}`, 'INVALID_RESPONSE');
        }
        const items = Array.isArray(data?.data) ? data.data
          : Array.isArray(data?.list) ? data.list
          : Array.isArray(data) ? data
          : [];
        const countryIds = items
          .map(item => Number(item.id || item.countryId || item.country_id || item.country))
          .filter(id => Number.isFinite(id) && id > 0);
        if (!countryIds.length) {
          throw new HerosmsError('getCountries: no valid country IDs in response', 'NO_COUNTRIES');
        }
        return countryIds;
      } finally {
        if (timer) clearTimeout(timer);
      }
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

    return { urlFor, getBalance, getPrices, getNumber, getStatus, setStatus, getCountries };
  }

  return {
    createHerosmsClient,
    HerosmsError,
    NoNumbersError,
    NoBalanceError,
    AuthenticationError,
    BannedError,
    DEFAULT_BASE_URL,
    COUNTRY_CODES,
    SERVICE_OPENAI,
    STATUS_CODES,
  };
});
