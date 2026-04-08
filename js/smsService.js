/**
 * smsService.js  — CDRRMO Admin Panel
 * Mocean: credentials in ./mocean-config.js, client in ./mocean-client.js (admin repo–local; no CDRRMO/ import).
 */
import {
  sendSMS as moceanSendSMS,
  formatToMoceanMsisdn,
  msisdnToPlus63,
  testMoceanSMS as moceanTestSms,
  sendCitizenTeamAssignedNotification,
} from './mocean-client.js';
import { firestore, collection, getDocs } from './firebase-api.js';

export async function notifyUser(phone, message) {
  const to = formatToMoceanMsisdn(phone);
  if (!to) {
    console.warn('[SMSService] notifyUser: invalid phone, skip:', phone);
    return { success: false, error: `Invalid phone number: ${phone}` };
  }
  console.log('[SMSService] Sending SMS to:', msisdnToPlus63(to));
  const result = await moceanSendSMS(to, message);
  console.log('[SMSService] notifyUser result:', result.success, result.error || '');
  return result;
}

export async function testMoceanSMS(phone) {
  return moceanTestSms(phone);
}

export async function notifyCitizenTeamAssigned(phone, opts) {
  return sendCitizenTeamAssignedNotification(phone, opts);
}

if (typeof window !== 'undefined') {
  window.testMoceanSMS = testMoceanSMS;
  window.notifyUser = notifyUser;
  window.notifyCitizenTeamAssigned = notifyCitizenTeamAssigned;
}

class SMSService {
  async sendSMS(phoneNumber, message) {
    return notifyUser(phoneNumber, message);
  }

  async sendBulkSMS(phoneNumbers, message) {
    const results = { success: 0, failed: 0, details: [] };
    console.log('[SMSService] sendBulkSMS loop start, count:', phoneNumbers?.length || 0);
    for (const phone of phoneNumbers) {
      if (!phone) {
        console.warn('[SMSService] sendBulkSMS: skip empty phone slot');
        continue;
      }
      const to = formatToMoceanMsisdn(phone);
      console.log('[SMSService] Sending SMS to:', to ? msisdnToPlus63(to) : `(invalid) ${phone}`);
      const result = await this.sendSMS(phone, message);
      result.success ? results.success++ : results.failed++;
      results.details.push({ phone, ...result });
      console.log('[SMSService] sendBulkSMS row:', to ? msisdnToPlus63(to) : phone, result.success ? 'ok' : result.error);
    }
    console.log(`[SMSService] Bulk done — success: ${results.success}, failed: ${results.failed}`);
    return results;
  }

  async sendTeamDispatchSMS(citizenData, teamData, responderPhones) {
    if (!responderPhones || responderPhones.length === 0) {
      console.warn('[SMSService] sendTeamDispatchSMS: no phone numbers provided.');
      return { success: 0, failed: 0, details: [] };
    }

    const message = this._buildTeamDispatchMessage(citizenData, teamData);
    console.log(`[SMSService] Dispatching to ${responderPhones.length} responder(s)...`);
    console.log('[SMSService] Message:\n', message);

    return await this.sendBulkSMS(responderPhones, message);
  }

  async sendSOSDispatchNotification(sosData, teamData, responderPhone) {
    const message = this._buildTeamDispatchMessage(
      {
        reportedByName: sosData.reportedByName || sosData.reportedBy || 'Unknown',
        contactNumber: sosData.reportedByContactNumber || sosData.contactNumber || 'N/A',
        location: sosData.location || 'Unknown location',
        coordinates: sosData.coordinates || null,
        type: sosData.type || 'SOS Emergency',
        additionalInfo: sosData.details || sosData.additionalInfo || '',
      },
      teamData
    );

    return await this.sendSMS(responderPhone, message);
  }

  async sendToMultipleResponders(sosData, teamData, responderPhones) {
    const results = { success: 0, failed: 0, details: [] };
    for (const phone of responderPhones) {
      if (!phone) continue;
      const result = await this.sendSOSDispatchNotification(sosData, teamData, phone);
      result.success ? results.success++ : results.failed++;
      results.details.push({ phone, ...result });
    }
    return results;
  }

  async sendDisasterAlertToAllCitizens(alertData) {
    console.log('[SMSService] Fetching citizen phone numbers...');
    let citizenPhones = [];

    try {
      const snap = await getDocs(collection(firestore, 'Citizen'));
      snap.forEach((d) => {
        const phone = d.data().citiContactNumber || d.data().contactNumber || null;
        if (phone) citizenPhones.push(phone);
      });
      console.log(`[SMSService] Found ${citizenPhones.length} citizen phone(s).`);
    } catch (error) {
      console.error('[SMSService] Error fetching citizens:', error);
      return { success: 0, failed: 0, total: 0, error: error.message };
    }

    if (citizenPhones.length === 0) {
      console.warn('[SMSService] No citizen phones found — no SMS sent.');
      return { success: 0, failed: 0, total: 0, details: [] };
    }

    const message = this._buildDisasterAlertMessage(alertData);
    const results = await this.sendBulkSMS(citizenPhones, message);
    return { ...results, total: citizenPhones.length };
  }

  async sendDisasterAlertToNumbers(alertData, phoneNumbers) {
    const message = this._buildDisasterAlertMessage(alertData);
    return await this.sendBulkSMS(phoneNumbers, message);
  }

  async testConnection(testPhone) {
    return testMoceanSMS(testPhone);
  }

  _buildTeamDispatchMessage(citizenData, teamData) {
    const ts = new Date().toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const lat = citizenData.coordinates?.latitude?.toFixed(6) ?? null;
    const lng = citizenData.coordinates?.longitude?.toFixed(6) ?? null;
    const mapLink = lat ? `https://maps.google.com/?q=${lat},${lng}` : 'N/A';

    let msg = `[CDRRMO] DISPATCH ALERT\n`;
    msg += `Team: ${teamData?.name || 'N/A'}\n`;
    msg += `Type: ${citizenData.type || 'Emergency'}\n`;
    msg += `─────────────\n`;
    msg += `Citizen: ${citizenData.reportedByName || 'Unknown'}\n`;
    msg += `Phone: ${citizenData.contactNumber || 'N/A'}\n`;
    msg += `─────────────\n`;
    msg += `Location: ${citizenData.location || 'Unknown'}\n`;
    msg += `Map: ${mapLink}\n`;

    if (citizenData.additionalInfo) {
      msg += `Notes: ${citizenData.additionalInfo}\n`;
    }

    msg += `─────────────\n`;
    msg += `Time: ${ts}\n`;
    msg += `Respond immediately.`;

    return msg;
  }

  _buildDisasterAlertMessage(alertData) {
    const ts = new Date().toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    return (
      `[CDRRMO] DISASTER ALERT\n` +
      `Type: ${alertData.type || 'Emergency Alert'}\n` +
      `Area: ${alertData.location || 'Your area'}\n` +
      `Info: ${alertData.details || 'Follow official instructions.'}\n` +
      `Time: ${ts}\n` +
      `Stay safe. Follow official CDRRMO instructions.`
    );
  }

  formatPhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');

    if (cleaned.startsWith('63') && cleaned.length === 12) {
      cleaned = '0' + cleaned.slice(2);
    } else if (cleaned.startsWith('9') && cleaned.length === 10) {
      cleaned = '0' + cleaned;
    }

    if (!/^09\d{9}$/.test(cleaned)) {
      console.warn('[SMSService] Invalid phone number after formatting:', cleaned);
      return null;
    }
    return cleaned;
  }
}

const smsService = new SMSService();
export default smsService;
