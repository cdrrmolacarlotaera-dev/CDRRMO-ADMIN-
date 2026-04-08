/**
 * Central admin real-time toasts + showAdminNotification()
 */
import {
  firestore,
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  limit,
} from './firebase-api.js';

let hubStarted = false;
const seenKeys = new Set();

export function showAdminNotification(message, { variant = 'info' } = {}) {
  let el = document.getElementById('adminRealtimeToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'adminRealtimeToast';
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:fixed;bottom:24px;right:24px;max-width:440px;padding:14px 18px;color:#fff;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.25);z-index:99999;font-family:system-ui,sans-serif;font-size:14px;line-height:1.45;';
    document.body.appendChild(el);
  }
  const colors = {
    info: '#0f172a',
    success: '#065f46',
    warning: '#92400e',
    danger: '#7f1d1d',
    assign: '#1e3a5f',
  };
  el.style.background = colors[variant] || colors.info;
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(el._hideT);
  el._hideT = setTimeout(() => {
    el.style.display = 'none';
  }, 7000);
}

function mark(key) {
  if (seenKeys.has(key)) return false;
  seenKeys.add(key);
  if (seenKeys.size > 500) seenKeys.clear();
  return true;
}

export function initAdminRealtimeHub() {
  if (hubStarted) return;
  hubStarted = true;

  const cols = ['Alerts', 'Reports', 'SOS'];

  cols.forEach((name) => {
    const qNew = query(collection(firestore, name), orderBy('timestamp', 'desc'), limit(50));
    let firstNew = true;
    onSnapshot(
      qNew,
      (snap) => {
        if (firstNew) {
          firstNew = false;
          return;
        }
        snap.docChanges().forEach((ch) => {
          if (ch.type !== 'added') return;
          const d = ch.doc.data();
          const ts = d.timestamp?.toDate?.();
          if (!ts || Date.now() - ts.getTime() > 4 * 60 * 1000) return;
          if (!mark(`new:${name}:${ch.doc.id}`)) return;
          const label =
            name === 'Alerts'
              ? 'New ALERT'
              : name === 'Reports'
                ? 'New EMERGENCY / Report'
                : 'New SOS';
          showAdminNotification(`${label}: ${d.type || ''} @ ${d.location || '—'}`, {
            variant: name === 'SOS' ? 'danger' : name === 'Reports' ? 'warning' : 'info',
          });
        });
      },
      (e) => console.error('[admin-notifications] new item', name, e)
    );
  });

  cols.forEach((name) => {
    const q = query(
      collection(firestore, name),
      where('status', 'in', ['pending', 'active', 'dispatched', 'ongoing'])
    );
    let firstAs = true;
    onSnapshot(
      q,
      (snap) => {
        if (firstAs) {
          firstAs = false;
          return;
        }
        snap.docChanges().forEach((ch) => {
          if (ch.type !== 'modified' && ch.type !== 'added') return;
          const d = ch.doc.data();
          const team = d.assignedTeamId || d.assignedTeam;
          if (!team) return;
          const at = d.assignedAt?.toDate?.();
          if (at && Date.now() - at.getTime() > 10 * 60 * 1000) return;
          if (!mark(`as:${name}:${ch.doc.id}:${team}`)) return;
          showAdminNotification(
            `Team assigned — ${name}: ${d.assignedTeamName || 'Team'} → ${d.type || ''} @ ${d.location || '—'}`,
            { variant: 'assign' }
          );
        });
      },
      (e) => console.error('[admin-notifications] assign', name, e)
    );
  });

  cols.forEach((name) => {
    const q = query(collection(firestore, name), where('isResolved', '==', true));
    let firstDone = true;
    onSnapshot(
      q,
      (snap) => {
        if (firstDone) {
          firstDone = false;
          return;
        }
        snap.docChanges().forEach((ch) => {
          if (ch.type !== 'added' && ch.type !== 'modified') return;
          const d = ch.doc.data();
          const ra = d.resolvedAt?.toDate?.() || d.missionCompletedAt?.toDate?.();
          if (!ra) return;
          if (Date.now() - ra.getTime() > 10 * 60 * 1000) return;
          if (!mark(`done:${name}:${ch.doc.id}`)) return;
          showAdminNotification(
            `Task completed — ${name}: ${d.type || ''} @ ${d.location || '—'}`,
            { variant: 'success' }
          );
        });
      },
      (e) => console.error('[admin-notifications] done', name, e)
    );
  });
}
