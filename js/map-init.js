import { initializeMap } from './map.js';
import { initAdminRealtimeHub } from './admin-notifications.js';

function boot() {
    if (typeof L === 'undefined') {
        setTimeout(boot, 500);
        return;
    }

    try { initAdminRealtimeHub(); }
    catch (e) { console.warn('[map-init] admin-notifications error:', e); }

    try { initializeMap(); }
    catch (e) { console.error('[map-init] initializeMap failed:', e); }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
