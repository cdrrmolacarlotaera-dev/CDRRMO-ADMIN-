import {
    firestore,
    collection,
    query,
    orderBy,
    limit,
    getDocs
} from './firebase-api.js';

async function loadActivity() {
    const tbody = document.getElementById('activity-body');
    const summary = document.getElementById('activity-summary');

    try {
        const logsRef = collection(firestore, 'SystemLogs');
        const q = query(logsRef, orderBy('createdAt', 'desc'), limit(100));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align:center; padding:32px; color: var(--gray-500);">
                        <i class="fas fa-inbox"></i> No activity recorded yet.
                    </td>
                </tr>
            `;
            summary.textContent = 'No activity yet';
            return;
        }

        const rows = [];
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const ts = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
            const timeStr = ts.toLocaleString();

            rows.push(`
                <tr>
                    <td>${timeStr}</td>
                    <td><code>${data.action || ''}</code></td>
                    <td>
                        <div>${data.targetType || ''}</div>
                        ${data.targetId ? `<small style="color: var(--gray-400);">ID: ${data.targetId}</small>` : ''}
                    </td>
                    <td>
                        <pre style="margin:0; white-space:pre-wrap; font-size:12px; color:var(--gray-700);">
${JSON.stringify(data.details || {}, null, 2)}
                        </pre>
                    </td>
                </tr>
            `);
        });

        tbody.innerHTML = rows.join('');
        summary.textContent = `Showing ${rows.length} recent actions`;
    } catch (e) {
        console.error('Error loading SystemLogs:', e);
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align:center; padding:32px; color:#ef4444;">
                    <i class="fas fa-exclamation-triangle"></i> Failed to load activity log.
                </td>
            </tr>
        `;
        summary.textContent = 'Error loading activity';
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadActivity);
} else {
    loadActivity();
}
