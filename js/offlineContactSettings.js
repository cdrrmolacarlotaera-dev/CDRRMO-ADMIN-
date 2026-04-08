/**
 * Admin: edit hotline used by citizen app for offline Call / SMS (AppSettings/offlineContact).
 */
import {
  firestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from './firebase-api.js';

const DOC_ID = 'offlineContact';

function $(id) {
  return document.getElementById(id);
}

function showModal(show) {
  const el = $('infoHotlineModal');
  if (!el) return;
  el.style.display = show ? 'flex' : 'none';
  if (show) $('offlineHotlineInput')?.focus();
}

async function loadHotlineIntoForm() {
  const input = $('offlineHotlineInput');
  const status = $('offlineHotlineStatus');
  if (!input) return;
  if (status) {
    status.textContent = 'Loading…';
    status.style.color = '#6b7280';
  }
  try {
    const ref = doc(firestore, 'AppSettings', DOC_ID);
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data()?.hotlinePhone) {
      input.value = String(snap.data().hotlinePhone).trim();
    } else {
      input.value = '';
    }
    if (status) {
      status.textContent = snap.exists()
        ? 'Loaded from Firestore.'
        : 'No number saved yet — enter one and save.';
      status.style.color = '#6b7280';
    }
  } catch (e) {
    console.error('[offlineContactSettings]', e);
    if (status) {
      status.textContent = 'Could not load. Check Firestore rules for AppSettings.';
      status.style.color = '#dc2626';
    }
  }
}

function validatePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10;
}

async function saveHotline() {
  const input = $('offlineHotlineInput');
  const status = $('offlineHotlineStatus');
  if (!input) return;
  const raw = input.value.trim();
  if (!validatePhone(raw)) {
    if (status) {
      status.textContent = 'Enter a valid number (at least 10 digits).';
      status.style.color = '#dc2626';
    }
    return;
  }
  if (status) {
    status.textContent = 'Saving…';
    status.style.color = '#6b7280';
  }
  try {
    const ref = doc(firestore, 'AppSettings', DOC_ID);
    await setDoc(
      ref,
      {
        hotlinePhone: raw,
        updatedAt: serverTimestamp(),
        label: 'Citizen offline Call / SMS hotline',
      },
      { merge: true }
    );
    if (status) {
      status.textContent = 'Saved. Citizen apps will pick this up on next online sync.';
      status.style.color = '#059669';
    }
    setTimeout(() => showModal(false), 1200);
  } catch (e) {
    console.error('[offlineContactSettings] save', e);
    if (status) {
      status.textContent = 'Save failed: ' + (e.message || 'unknown error');
      status.style.color = '#dc2626';
    }
  }
}

export function initOfflineContactSettings() {
  const btn = $('infoHotlineBtn');
  const modal = $('infoHotlineModal');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => {
    showModal(true);
    loadHotlineIntoForm();
  });

  $('infoHotlineClose')?.addEventListener('click', () => showModal(false));
  $('infoHotlineCancel')?.addEventListener('click', () => showModal(false));
  $('infoHotlineSave')?.addEventListener('click', () => saveHotline());

  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) showModal(false);
  });
}
