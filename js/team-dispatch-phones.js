/**
 * Resolve every phone number that should receive “team assigned / dispatch” SMS.
 * Teams often only store `contact` (hotline) and `members` (count) — not `memberIds`.
 * Responders are linked via respAssignedTeamId / respAssignedTeamName.
 */
import {
  firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from './firebase-api.js';
import {
  extractResponderPhoneFromData,
  formatToMoceanMsisdn,
  msisdnToPlus63,
} from './mocean-client.js';

function addPhone(rawList, seenMsisdns, value) {
  if (value == null || String(value).trim() === '') return;
  const s = String(value).trim();
  const m = formatToMoceanMsisdn(s);
  if (!m || seenMsisdns.has(m)) return;
  seenMsisdns.add(m);
  rawList.push(s);
}

/**
 * @param {string} teamId Firestore Teams document id
 * @param {string} [teamName]
 * @returns {Promise<string[]>} raw phone strings (Mocean layer normalizes)
 */
export async function getPhonesForTeamDispatch(teamId, teamName) {
  const rawList = [];
  const seenMsisdns = new Set();

  try {
    const teamSnap = await getDoc(doc(firestore, 'Teams', teamId));
    const teamData = teamSnap.exists() ? teamSnap.data() : {};

    addPhone(rawList, seenMsisdns, teamData.contact);
    addPhone(rawList, seenMsisdns, teamData.contactNumber);
    addPhone(rawList, seenMsisdns, teamData.leaderPhone);
    addPhone(rawList, seenMsisdns, teamData.phone);

    const memberIds = teamData.memberIds || [];
    for (const mid of memberIds) {
      if (!mid) continue;
      try {
        const r = await getDoc(doc(firestore, 'Responder', String(mid)));
        if (r.exists()) {
          addPhone(rawList, seenMsisdns, extractResponderPhoneFromData(r.data()));
        }
      } catch (e) {
        console.warn('[TeamDispatchPhones] memberId fetch:', mid, e?.message || e);
      }
    }

    const qTeamId = query(
      collection(firestore, 'Responder'),
      where('respAssignedTeamId', '==', teamId)
    );
    const snapTeamId = await getDocs(qTeamId);
    snapTeamId.forEach((d) => {
      addPhone(rawList, seenMsisdns, extractResponderPhoneFromData(d.data()));
    });

    if (teamName && String(teamName).trim()) {
      const qName = query(
        collection(firestore, 'Responder'),
        where('respAssignedTeamName', '==', teamName)
      );
      const snapName = await getDocs(qName);
      snapName.forEach((d) => {
        addPhone(rawList, seenMsisdns, extractResponderPhoneFromData(d.data()));
      });
    }
  } catch (e) {
    console.error('[TeamDispatchPhones] error:', e);
  }

  const display = rawList.map((p) => {
    const m = formatToMoceanMsisdn(p);
    return m ? msisdnToPlus63(m) : p;
  });
  console.log('[TeamDispatchPhones] team', teamId, teamName || '', '→', display.length, 'number(s):', display);

  return rawList;
}
