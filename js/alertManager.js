/**
 * alertManager.js  — CDRRMO Admin Panel
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the "Create Alert / Disaster Warning" modal.
 *
 * SMS Integration (NEW):
 *   When submitAlert() saves to Firestore it now also calls
 *   smsService.sendDisasterAlertToAllCitizens(alertData), which:
 *     1. Fetches every citizen phone number from Firestore.
 *     2. Sends bulk Mocean SMS to each number.
 *     3. Reports success / failure counts in the UI.
 *
 * No other existing logic has been changed.
 */

import {
  firestore,
  collection,
  addDoc,
  serverTimestamp,
} from './firebase-api.js';
import adminLogger from './admin-logger.js';
import { createSafeMarker } from './map.js';
import smsService from './smsService.js'; // ← NEW
import { initAdminRealtimeHub, showAdminNotification } from './admin-notifications.js';

// ─── MAP STATE ───────────────────────────────────────────────────────────────

let map;
let marker;
let selectedLocation = {
  lat: 10.4267, // Default: La Carlota City, Negros Occidental
  lng: 122.9211,
  address: '',
};

// ─── MAP INIT ────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map('alertMap').setView([selectedLocation.lat, selectedLocation.lng], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  marker = createSafeMarker(selectedLocation.lat, selectedLocation.lng, null, { draggable: true });
  if (marker) {
    marker.addTo(map);
    marker.on('dragend', function () {
      const position = marker.getLatLng();
      getAddressFromLatLng(position.lat, position.lng);
    });
    getAddressFromLatLng(selectedLocation.lat, selectedLocation.lng);
  }

  map.on('click', function (e) {
    if (marker) {
      marker.setLatLng(e.latlng);
      getAddressFromLatLng(e.latlng.lat, e.latlng.lng);
    }
  });
}

function getAddressFromLatLng(lat, lng) {
  fetch(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
  )
    .then((response) => response.json())
    .then((data) => {
      if (data && data.display_name) {
        selectedLocation = { lat, lng, address: data.display_name };
      } else {
        selectedLocation = { lat, lng, address: `Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}` };
      }
      document.getElementById('selectedLocation').textContent = selectedLocation.address;
    })
    .catch((error) => {
      console.error('Geocoding failed:', error);
      selectedLocation = { lat, lng, address: `Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}` };
      document.getElementById('selectedLocation').textContent = selectedLocation.address;
    });
}

function searchLocation() {
  const searchQuery = document.getElementById('location-search').value;
  if (!searchQuery) return;

  document.getElementById('selectedLocation').textContent = 'Searching...';

  fetch(
    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      searchQuery
    )}&limit=1`
  )
    .then((response) => response.json())
    .then((data) => {
      if (data && data.length > 0) {
        const result = data[0];
        const lat = parseFloat(result.lat);
        const lng = parseFloat(result.lon);
        map.setView([lat, lng], 15);
        marker.setLatLng([lat, lng]);
        getAddressFromLatLng(lat, lng);
      } else {
        document.getElementById('selectedLocation').textContent =
          'Location not found. Try a different search.';
      }
    })
    .catch((error) => {
      console.error('Search failed:', error);
      document.getElementById('selectedLocation').textContent = 'Search failed. Please try again.';
    });
}

function getCurrentLocation() {
  if (!navigator.geolocation) {
    document.getElementById('selectedLocation').textContent =
      'Geolocation is not supported by your browser.';
    return;
  }

  document.getElementById('selectedLocation').textContent = 'Fetching your location...';

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      map.setView([lat, lng], 16);
      marker.setLatLng([lat, lng]);
      getAddressFromLatLng(lat, lng);
    },
    (error) => {
      console.error('Geolocation error:', error);
      let errorMessage = 'Could not get your location.';
      switch (error.code) {
        case error.PERMISSION_DENIED:
          errorMessage = 'Location access denied. Please enable location services.';
          break;
        case error.POSITION_UNAVAILABLE:
          errorMessage = 'Location information unavailable.';
          break;
        case error.TIMEOUT:
          errorMessage = 'Location request timed out.';
          break;
      }
      document.getElementById('selectedLocation').textContent = errorMessage;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function initMapControls() {
  document.getElementById('search-button').addEventListener('click', searchLocation);
  document.getElementById('location-search').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') searchLocation();
  });
  document.getElementById('current-location').addEventListener('click', getCurrentLocation);
}

// ─── SUBMIT ALERT ────────────────────────────────────────────────────────────

/**
 * Save alert to Firestore and send bulk SMS to all citizens.
 */
async function submitAlert() {
  const alertType    = document.getElementById('alertType').value;
  const alertDetails = document.getElementById('alertDetails').value;
  const submitBtn    = document.getElementById('submitAlert');

  if (!alertType) {
    alert('Please select an alert type');
    return;
  }
  if (!selectedLocation.address) {
    alert('Please select a location on the map');
    return;
  }
  if (!alertDetails) {
    alert('Please enter alert details');
    return;
  }

  // Disable the button to prevent double-submit
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
  }

  try {
    // 1. Build alert document
    const alertData = {
      type: alertType,
      location: selectedLocation.address,
      details: alertDetails,
      coordinates: {
        latitude: selectedLocation.lat,
        longitude: selectedLocation.lng,
      },
      timestamp: serverTimestamp(),
      status: 'active',
      isResolved: false,
    };

    // 2. Save to Firestore
    const docRef = await addDoc(collection(firestore, 'Alerts'), alertData);
    console.log('[AlertManager] Alert created, ID:', docRef.id);

    // 3. Log admin action
    adminLogger.log('create_alert', 'Alert', docRef.id, {
      type: alertType,
      location: selectedLocation.address,
    });

    // 4. Send SMS to all registered citizens via Mocean ─────────────────────────
    console.log('[AlertManager] Starting bulk SMS to citizens…');

    // Show an in-progress note in the UI without blocking the flow
    _showSMSStatus('Sending SMS alerts to citizens…', 'info');

    // Fire-and-forget — SMS is async and should not block the modal close
    smsService
      .sendDisasterAlertToAllCitizens(alertData)
      .then((smsResult) => {
        console.log('[AlertManager] Bulk SMS result:', smsResult);

        if (smsResult.error) {
          _showSMSStatus(
            `SMS failed: ${smsResult.error}`,
            'error'
          );
          return;
        }

        const msg =
          `SMS sent to ${smsResult.success} citizen(s)` +
          (smsResult.failed > 0 ? `, ${smsResult.failed} failed.` : '.');

        _showSMSStatus(msg, smsResult.failed > 0 ? 'warning' : 'success');
      })
      .catch((err) => {
        console.error('[AlertManager] Bulk SMS exception:', err);
        _showSMSStatus(`SMS error: ${err.message}`, 'error');
      });
    // ──────────────────────────────────────────────────────────────────────────

    // 5. Reset form and close modal immediately (SMS continues in background)
    document.getElementById('alertType').value = '';
    document.getElementById('alertDetails').value = '';
    document.getElementById('alertModal').style.display = 'none';

    alert(
      `✅ Alert created successfully!\n\n` +
      `Type: ${alertType}\n` +
      `Location: ${selectedLocation.address}\n\n` +
      `SMS notifications are being sent to registered citizens.`
    );
  } catch (error) {
    console.error('[AlertManager] Error creating alert:', error);
    alert('Error creating alert. Please try again.\n\nDetails: ' + error.message);
  } finally {
    // Re-enable the button
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Alert';
    }
  }
}

// ─── SMS STATUS HELPER ───────────────────────────────────────────────────────

/**
 * Show an SMS status message in the admin UI.
 * Looks for a <div id="smsStatus"> on the page; if absent it falls back to console.
 *
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} level
 */
function _showSMSStatus(message, level = 'info') {
  const colors = {
    info:    '#3498db',
    success: '#2ecc71',
    warning: '#f39c12',
    error:   '#e74c3c',
  };

  const statusEl = document.getElementById('smsStatus');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.style.color = colors[level] || colors.info;
    statusEl.style.display = 'block';

    // Auto-hide after 8 seconds
    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 8000);
  }

  // Always log to console as well
  const logFn = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
  logFn(`[AlertManager SMS] ${message}`);
}

// ─── MODAL MANAGEMENT ────────────────────────────────────────────────────────

function openAlertModal() {
  const modal = document.getElementById('alertModal');
  modal.style.display = 'flex';

  setTimeout(() => {
    if (!map) {
      initMap();
      initMapControls();
    } else {
      map.invalidateSize();
    }
  }, 300);
}

function initAlertModal() {
  const modal         = document.getElementById('alertModal');
  const openModalBtn  = document.getElementById('createAlertBtn');
  const openModalBtn2 = document.getElementById('createAlertBtn2');
  const closeSpan     = document.querySelector('.close');
  const closeBtn      = document.querySelector('.close-btn');
  const submitBtn     = document.getElementById('submitAlert');

  if (openModalBtn)  openModalBtn.onclick  = openAlertModal;
  if (openModalBtn2) openModalBtn2.onclick = openAlertModal;

  if (closeSpan) closeSpan.onclick = () => { modal.style.display = 'none'; };
  if (closeBtn)  closeBtn.onclick  = () => { modal.style.display = 'none'; };

  window.onclick = (event) => {
    if (event.target === modal) modal.style.display = 'none';
  };

  if (submitBtn) submitBtn.onclick = submitAlert;
}

// ─── BOOT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  initAlertModal();
  try {
    initAdminRealtimeHub();
  } catch (e) {
    console.warn('initAdminRealtimeHub', e);
  }
});

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

export { initAlertModal, initMap, openAlertModal, submitAlert, showAdminNotification };