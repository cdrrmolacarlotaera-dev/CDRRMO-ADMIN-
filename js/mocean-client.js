/**
 * Browser Mocean REST client for the admin panel only.
 * Credentials: edit ./mocean-config.js (keeps admin repo independent from the citizen CDRRMO app).
 */
import { MOCEAN_CONFIG } from './mocean-config.js';

export function formatToMoceanMsisdn(phone) {
  if (phone == null || phone === '') return null;
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('63') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('0') && cleaned.length === 11 && cleaned[1] === '9') {
    return '63' + cleaned.slice(1);
  }
  if (cleaned.length === 10 && cleaned.startsWith('9')) {
    return '63' + cleaned;
  }
  return null;
}

function isMoceanSuccess(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const block = parsed['mocean-api-response'] || parsed;
  const st = block?.status;
  if (st === 0 || st === '0') return true;
  if (block?.messages && Array.isArray(block.messages)) {
    const first = block.messages[0];
    if (first?.status === 0 || first?.status === '0') return true;
  }
  return false;
}

function extractMoceanError(parsed, fallback) {
  if (!parsed || typeof parsed !== 'object') return fallback;
  const block = parsed['mocean-api-response'] || parsed;
  const msgs = block?.messages;
  const first = Array.isArray(msgs) ? msgs[0] : null;
  const msg = first?.err_msg || first?.message || block?.messages?.[0]?.err_msg;
  return (
    msg ||
    block?.['mocean-error'] ||
    parsed?.message ||
    block?.message ||
    fallback
  );
}

export function isInsufficientBalanceMoceanResponse(data) {
  if (!data || typeof data !== 'object') return false;
  const block = data['mocean-api-response'] || data;
  const arr = block.messages || data.messages;
  if (!Array.isArray(arr)) return false;
  return arr.some((m) => {
    const st = m?.status;
    const err = String(m?.err_msg || '').toLowerCase();
    return st === 2 || st === '2' || err.includes('insufficient balance') || err.includes('insufficient credit');
  });
}

export function validateMoceanConfigForSend() {
  const from = String(MOCEAN_CONFIG.FROM || '').trim();
  const key = String(MOCEAN_CONFIG.API_KEY || '').trim();
  const secret = String(MOCEAN_CONFIG.API_SECRET || '').trim();
  const token = String(MOCEAN_CONFIG.API_TOKEN || '').trim();
  if (!from) {
    return { ok: false, error: 'MOCEAN_CONFIG.FROM (sender ID) is required' };
  }
  if (!(key && secret) && !token) {
    return {
      ok: false,
      error: 'Set MOCEAN_CONFIG.API_KEY + API_SECRET, or API_TOKEN in js/mocean-config.js',
    };
  }
  return { ok: true };
}

function responderPhoneFromData(data) {
  return (
    data?.respPhone ||
    data?.respContactNumber ||
    data?.respPhoneNumber ||
    data?.respContact ||
    data?.phone ||
    data?.contactNumber ||
    ''
  );
}

export function extractResponderPhoneFromData(data) {
  return responderPhoneFromData(data) || '';
}

export function msisdnToPlus63(msisdn) {
  if (msisdn == null || msisdn === '') return '';
  const d = String(msisdn).replace(/\D/g, '');
  if (!d) return '';
  return d.startsWith('63') ? `+${d}` : `+${d}`;
}

function buildMoceanFields(msisdn, text) {
  const from = String(MOCEAN_CONFIG.FROM || 'MOCEAN').trim();
  const key = String(MOCEAN_CONFIG.API_KEY || '').trim();
  const secret = String(MOCEAN_CONFIG.API_SECRET || '').trim();
  const token = String(MOCEAN_CONFIG.API_TOKEN || '').trim();

  const fields = {
    'mocean-to': msisdn,
    'mocean-from': from || 'MOCEAN',
    'mocean-text': text,
  };

  if (key && secret) {
    fields['mocean-api-key'] = key;
    fields['mocean-api-secret'] = secret;
  } else if (token) {
    fields['mocean-api-token'] = token;
  }

  return { fields, key, secret, token, from: fields['mocean-from'] };
}

function encodeMoceanForm(fields) {
  const params = new URLSearchParams();
  Object.entries(fields).forEach(([k, v]) => {
    if (v != null && String(v) !== '') params.append(k, String(v));
  });
  return params.toString();
}

function logMoceanDebug(fields, mode) {
  const safe = {
    mode,
    'mocean-to': fields['mocean-to'],
    'mocean-from': fields['mocean-from'],
    'mocean-text': `[${String(fields['mocean-text'] || '').length} chars]`,
    auth: fields['mocean-api-key']
      ? 'mocean-api-key+secret'
      : fields['mocean-api-token']
        ? 'mocean-api-token'
        : 'none',
  };
  console.log('[MoceanSMS] outbound (sanitized):', JSON.stringify(safe));
}

export async function sendSMS(to, message) {
  const cfg = validateMoceanConfigForSend();
  if (!cfg.ok) {
    console.warn('[MoceanSMS] sendSMS skipped (config):', cfg.error);
    return { success: false, error: cfg.error, skipped: true };
  }

  let text = (message || '').trim();
  if (!text) {
    return { success: false, error: 'Empty message' };
  }
  if (text.length > 2000) {
    text = text.slice(0, 1997) + '...';
  }

  let msisdn = formatToMoceanMsisdn(to);
  if (!msisdn && typeof to === 'string') {
    const d = to.replace(/\D/g, '');
    if (d.startsWith('63') && d.length === 12) msisdn = d;
  }
  if (!msisdn) {
    return { success: false, error: 'Invalid phone number (use PH mobile)' };
  }

  const { fields, key, secret, token } = buildMoceanFields(msisdn, text);

  if (!fields['mocean-to'] || !fields['mocean-from'] || !fields['mocean-text']) {
    return { success: false, error: 'Missing mocean-to, mocean-from, or mocean-text' };
  }
  if (!(key && secret) && !token) {
    return {
      success: false,
      error:
        'Mocean auth missing: set MOCEAN_CONFIG.API_KEY and API_SECRET (recommended), or API_TOKEN',
    };
  }

  const formBody = encodeMoceanForm(fields);
  logMoceanDebug(fields, 'form-urlencoded');
  const logTo = msisdnToPlus63(msisdn);
  console.log('[MoceanSMS] Sending SMS to:', logTo || msisdn);

  const postOnce = async (headers, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      return await fetch(MOCEAN_CONFIG.BASE_URL, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await postOnce(
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      formBody
    );

    let raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = { _raw: raw };
    }

    const missingParams =
      res.status === 401 &&
      typeof data === 'object' &&
      String(extractMoceanError(data, '') || '').includes('mandatory');

    if (!res.ok && missingParams && token && !key) {
      console.warn('[MoceanSMS] Retrying with Bearer + form body (token-only account)');
      const tokenFields = {
        'mocean-to': fields['mocean-to'],
        'mocean-from': fields['mocean-from'],
        'mocean-text': fields['mocean-text'],
      };
      const retryBody = encodeMoceanForm(tokenFields);
      logMoceanDebug(tokenFields, 'form-urlencoded+Bearer');
      res = await postOnce(
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        retryBody
      );
      raw = await res.text();
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = { _raw: raw };
      }
    }

    if (!res.ok) {
      const apiData = data;
      const msg =
        (apiData && typeof apiData === 'object' && extractMoceanError(apiData, null)) ||
        (typeof apiData === 'object' && apiData?.message) ||
        `HTTP ${res.status}: ${raw || res.statusText}`;
      const low = String(msg).toLowerCase();
      const balance = isInsufficientBalanceMoceanResponse(apiData) || low.includes('insufficient balance');
      console.warn('[MoceanSMS] sendSMS HTTP error for', logTo || msisdn, res.status, msg);
      if (balance) {
        console.warn('[MoceanSMS] sendSMS skipped — insufficient Mocean account balance');
      }
      return {
        success: false,
        error: String(msg),
        data: apiData,
        insufficientBalance: balance,
      };
    }

    const block = data && typeof data === 'object' ? data['mocean-api-response'] || data : null;
    const firstMsg = block?.messages?.[0];
    if (firstMsg != null) {
      console.log(
        '[MoceanSMS] API message status for',
        logTo || msisdn,
        'status=',
        firstMsg.status,
        'err_msg=',
        firstMsg.err_msg || firstMsg.message || '(none)'
      );
    } else if (block && block.status != null) {
      console.log('[MoceanSMS] API block status for', logTo || msisdn, 'status=', block.status);
    }
    const rawLog =
      typeof data === 'object' && data
        ? JSON.stringify(data).slice(0, 2500)
        : String(raw).slice(0, 500);
    console.log('[MoceanSMS] sendSMS raw response (after send, truncated):', rawLog);

    if (isMoceanSuccess(data)) {
      console.log('[MoceanSMS] sendSMS success for', logTo || msisdn);
      return { success: true, data };
    }

    const errMsg = extractMoceanError(data, 'SMS send failed');
    const balanceFail = isInsufficientBalanceMoceanResponse(data);
    if (balanceFail) {
      console.warn('[MoceanSMS] Mocean reported failure (e.g. insufficient balance):', errMsg);
    } else {
      console.warn('[MoceanSMS] non-success Mocean body (HTTP OK but delivery may have failed):', errMsg);
    }
    return {
      success: false,
      error: String(errMsg),
      data,
      insufficientBalance: balanceFail,
    };
  } catch (error) {
    const msg = error.name === 'AbortError' ? 'Request timed out' : error.message;
    console.warn('[MoceanSMS] sendSMS exception:', logTo || msisdn, msg);
    return {
      success: false,
      error: String(msg),
      data: undefined,
    };
  }
}

export async function testMoceanSMS(phone) {
  const body = `[CDRRMO] Mocean SMS test. ${new Date().toISOString()}`;
  return sendSMS(phone, body);
}

export async function sendCitizenTeamAssignedNotification(phone, opts = {}) {
  if (!phone || !String(phone).trim()) {
    return { success: false, error: 'No citizen phone' };
  }
  const teamName = opts.teamName || 'Response team';
  const caseType = opts.caseType || 'emergency';
  const location = String(opts.location || 'See CDRRMO app').slice(0, 220);
  const refId = opts.refId || '';
  const msg =
    `[CDRRMO] Your ${caseType} has been assigned to team "${teamName}". ` +
    `Responders were notified by SMS.\nRef: ${refId}\nLocation: ${location}`;
  return sendSMS(phone, msg);
}

if (typeof globalThis !== 'undefined') {
  globalThis.testMoceanSMSServiceSMS = testMoceanSMS;
}
