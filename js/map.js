import { 
  firestore,
  collection, 
  query, 
  where, 
  getDocs,
  getDoc,
  doc,
  updateDoc,
  onSnapshot,
  serverTimestamp
} from './firebase-api.js';
import adminLogger from './admin-logger.js';
import smsService, { notifyCitizenTeamAssigned } from './smsService.js';
import { getPhonesForTeamDispatch } from './team-dispatch-phones.js';
import {
  releaseAssignedTeamAfterResolve,
  releasePreviousTeamOnReassign,
} from './release-team-on-resolve.js';

// Initialize global variables
let map;
let allMarkers = []; // Array to store all markers
let availableTeams = []; // Cache for teams
let currentEmergency = null; // Currently selected emergency for assignment
let emergencyUnsubscribers = []; // Track Firestore listeners for cleanup
let alertsData = [];
let reportsData = [];
let sosData = [];
let filters = {
  emergencyType: 'all',
  incidentType: 'all',
  location: '',
  dateFrom: null,
  dateTo: null,
  activeOnly: false
};

// Global variable to store default map position - Negros Island
let defaultMapPosition = [10.45, 123.05];
let defaultZoom = 9;

/** From analytics deep link ?lat=&lng= — center map on real incident coords, not Nominatim guess. */
let pendingFocusFromUrl = null; // { lat, lng, zoom }

/**
 * If ?location= has no coords, try geocode only when no markers matched (after first paint).
 * Avoids wrong global Nominatim hit overriding correct fitBounds to Firestore markers.
 */
let pendingLocationGeocodeFallback = null;

// Bias free-text geocode toward CDRRMO area (La Carlota / Negros)
const GEOCODE_ANCHOR = { lat: 10.4267, lng: 122.9211 };
const GEOCODE_SUFFIX = ', La Carlota City, Negros Occidental, Philippines';

// Philippines bounding box for coordinate validation
const PH_BOUNDS = { latMin: 4.5, latMax: 21.5, lngMin: 116.0, lngMax: 127.0 };

const OPEN_MAP_STATUSES = ['pending', 'active', 'dispatched', 'ongoing'];

function isOpenIncidentForMap(emergency) {
  if (emergency.isResolved === true) return false;
  const s = (emergency.status || '').toString().toLowerCase();
  return OPEN_MAP_STATUSES.includes(s);
}

/** True when a real team id is stored (not empty string / placeholder). */
function teamAssignmentPresent(emergency) {
  const raw = emergency.assignedTeamId ?? emergency.assignedTeam;
  if (raw === undefined || raw === null || raw === false) return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  return true;
}

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/**
 * createSafeMarker — exported so alertManager.js can import it.
 * Creates a Leaflet marker only when coordinates are valid numbers.
 * Returns null for NaN, infinite, or [0,0] values.
 */
export function createSafeMarker(lat, lng, icon = null, options = {}) {
  lat = parseFloat(lat);
  lng = parseFloat(lng);
  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  const markerOptions = icon ? { ...options, icon } : options;
  return L.marker([lat, lng], markerOptions);
}


// Debounce function to limit how often a function can be called
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Initialize the map when the DOM is loaded
export function initializeMap() {
  map = L.map('map-container').setView(defaultMapPosition, defaultZoom);
  
  // Add a tile layer (the map's background)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  
  // Set up event listeners - Real-time map updates on filter change
  document.getElementById('emergency-type-filter').addEventListener('change', function() {
      filters.emergencyType = this.value;
      refreshDisplayFromCache(); // Client-side filter - just redraw
  });

  document.getElementById('incident-filter').addEventListener('change', function() {
      filters.incidentType = this.value;
      refreshDisplayFromCache(); // Client-side filter - just redraw
  });

  // Update the location search to navigate automatically with debounce
  const locationSearchInput = document.getElementById('location-search');

  // Filter updates on input; debounce map refresh to avoid excessive redraws
  const debouncedRefresh = debounce(() => refreshDisplayFromCache(), 300);
  locationSearchInput.addEventListener('input', function() {
    filters.location = this.value.toLowerCase();
    debouncedRefresh();
  });

  // But navigation happens after typing stops (500ms delay)
  const debouncedGeocode = debounce((value) => {
    if (value.trim().length > 2) { // Only search if there are at least 3 characters
      geocodeAndNavigate(value);
    }
  }, 500);

  locationSearchInput.addEventListener('input', function() {
    debouncedGeocode(this.value);
  });

  // Keep the Enter key functionality for immediate search
  locationSearchInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      geocodeAndNavigate(this.value);
    }
  });
  
  document.getElementById('date-from').addEventListener('change', function() {
      filters.dateFrom = this.value ? new Date(this.value) : null;
      refreshDisplayFromCache(); // Client-side filter - just redraw
  });

  document.getElementById('date-to').addEventListener('change', function() {
      filters.dateTo = this.value ? new Date(this.value) : null;
      // Set to end of day
      if (filters.dateTo) {
          filters.dateTo.setHours(23, 59, 59, 999);
      }
      refreshDisplayFromCache(); // Client-side filter - just redraw
  });

  document.getElementById('active-only').addEventListener('change', function() {
      filters.activeOnly = this.checked;
      setupEmergencyListeners(); // Query changes - re-subscribe
  });

  document.getElementById('clear-filters').addEventListener('click', clearFilters);
  document.getElementById('refresh-map').addEventListener('click', loadAllEmergencies);
  
  // Deep link from High-Risk analytics: ?location= & optional ?lat=&lng= & analytics=1
  const urlParams = new URLSearchParams(window.location.search);
  const locationParam = urlParams.get('location');
  const fromHighRiskAnalytics = urlParams.get('analytics') === '1';
  const urlLat = parseFloat(urlParams.get('lat') || '');
  const urlLng = parseFloat(urlParams.get('lng') || '');

  if (locationParam) {
    const locDisplay = locationParam.trim();
    filters.location = locDisplay.toLowerCase();
    const locationSearchInput2 = document.getElementById('location-search');
    if (locationSearchInput2) locationSearchInput2.value = locDisplay;

    // Any location deep link: show Alerts + Reports + SOS (not e.g. "Reports" only).
    filters.emergencyType = 'all';
    filters.incidentType = 'all';
    const et = document.getElementById('emergency-type-filter');
    if (et) et.value = 'all';
    const it = document.getElementById('incident-filter');
    if (it) it.value = 'all';
  }

  // High-risk dashboard also counts resolved/historical rows; map queries omit them unless
  // "Show All Record Reports" is on — analytics=1 enables that for the drill-down.
  if (locationParam && fromHighRiskAnalytics) {
    filters.activeOnly = true;
    const ao = document.getElementById('active-only');
    if (ao) ao.checked = true;
  }

  if (
    !Number.isNaN(urlLat) &&
    !Number.isNaN(urlLng) &&
    urlLat >= PH_BOUNDS.latMin &&
    urlLat <= PH_BOUNDS.latMax &&
    urlLng >= PH_BOUNDS.lngMin &&
    urlLng <= PH_BOUNDS.lngMax
  ) {
    pendingFocusFromUrl = { lat: urlLat, lng: urlLng, zoom: 16 };
  } else if (locationParam) {
    pendingLocationGeocodeFallback = locationParam;
  }

  // Initial load of the map data (markers + fitBounds or pending focus — do not geocode before markers)
  loadAllEmergencies();

  // Sidebar/layout can leave the map at 0×0 on first paint; OSM tiles need a real size.
  // On GitHub Pages the stylesheet may arrive after JS — multiple delayed invalidateSize
  // calls ensure Leaflet re-measures once the container has its CSS height.
  requestAnimationFrame(() => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 300);
  setTimeout(() => map.invalidateSize(), 1000);
  setTimeout(() => map.invalidateSize(), 3000);
  window.addEventListener('load', () => map.invalidateSize());

  // Make the mark as resolved function globally available
  window.markEmergencyAsResolved = markEmergencyAsResolved;
}

// Clean up Firestore listeners when re-subscribing or when filters that affect queries change
function cleanupEmergencyListeners() {
  emergencyUnsubscribers.forEach(unsub => unsub());
  emergencyUnsubscribers = [];
}

// Refresh map display from cached data (used when client-side filters change)
function refreshDisplayFromCache() {
  clearAllMarkers();
  displayEmergencies(alertsData, reportsData, sosData);
  updateStatusMessage(alertsData.length, reportsData.length, sosData.length);
}

// Set up real-time Firestore listeners for Alerts, Reports, and SOS
function setupEmergencyListeners() {
  cleanupEmergencyListeners();
  showLoading(true);

  // Debounce to coalesce rapid updates when multiple listeners fire at once
  const refreshMap = debounce(() => {
    clearAllMarkers();
    displayEmergencies(alertsData, reportsData, sosData);
    updateStatusMessage(alertsData.length, reportsData.length, sosData.length);
    showLoading(false);
  }, 50);

  // Alerts listener
  const alertsRef = collection(firestore, 'Alerts');
  let alertQuery = query(alertsRef);
  if (!filters.activeOnly) {
    // Include 'active' — admin "Create Alert" uses status 'active' (not pending/dispatched/ongoing)
    alertQuery = query(
      alertsRef,
      where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active'])
    );
  }
  const unsubAlerts = onSnapshot(alertQuery, (snapshot) => {
    alertsData = snapshot.docs.map(docSnap => ({
      ...docSnap.data(),
      id: docSnap.id,
      emergencyType: 'alert'
    }));
    console.log('=== Alerts updated (real-time) ===', alertsData.length);
    refreshMap();
  }, (error) => {
    console.error('Error listening to Alerts:', error);
    showLoading(false);
  });
  emergencyUnsubscribers.push(unsubAlerts);

  // Reports listener
  const reportsRef = collection(firestore, 'Reports');
  let reportQuery = query(reportsRef);
  if (!filters.activeOnly) {
    reportQuery = query(
      reportsRef,
      where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active'])
    );
  }
  const unsubReports = onSnapshot(reportQuery, (snapshot) => {
    reportsData = snapshot.docs.map(docSnap => ({
      ...docSnap.data(),
      id: docSnap.id,
      emergencyType: 'report'
    }));
    console.log('=== Reports updated (real-time) ===', reportsData.length);
    refreshMap();
  }, (error) => {
    console.error('Error listening to Reports:', error);
    showLoading(false);
  });
  emergencyUnsubscribers.push(unsubReports);

  // SOS listener
  const sosRef = collection(firestore, 'SOS');
  let sosQuery = query(sosRef);
  if (!filters.activeOnly) {
    sosQuery = query(
      sosRef,
      where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active'])
    );
  }
  const unsubSOS = onSnapshot(sosQuery, (snapshot) => {
    sosData = snapshot.docs.map(docSnap => ({
      ...docSnap.data(),
      id: docSnap.id,
      emergencyType: 'sos'
    }));
    console.log('=== SOS updated (real-time) ===', sosData.length);
    refreshMap();
  }, (error) => {
    console.error('Error listening to SOS:', error);
    showLoading(false);
  });
  emergencyUnsubscribers.push(unsubSOS);
}

// Function to load all emergency data - now uses real-time listeners
// When filters that affect Firestore queries change (activeOnly), re-subscribe
// When only client-side filters change, just refresh display from cache
export function loadAllEmergencies() {
  setupEmergencyListeners();
}

// Update status message on the page - 3 Legend Types
function updateStatusMessage(alerts, reports, sos) {
    const statusEl = document.getElementById('map-status');
    if (statusEl) {
        const total = alerts + reports + sos;
        
        // Build filter info
        let filterInfo = '';
        if (filters.emergencyType !== 'all') {
            const filterLabels = {
                'alerts': 'Alerts (Admin)',
                'reports': 'Emergencies (Citizen)',
                'sos': 'SOS (Critical)'
            };
            filterInfo += ` | Filter: ${filterLabels[filters.emergencyType] || filters.emergencyType}`;
        }
        if (filters.incidentType !== 'all') {
            filterInfo += ` | Category: ${filters.incidentType}`;
        }
        if (filters.location) {
            filterInfo += ` | Location: "${filters.location}"`;
        }
        if (filters.activeOnly) {
            filterInfo += ' | Showing all (including resolved)';
        }
        
        if (total === 0) {
            statusEl.innerHTML = `<i class="fas fa-info-circle"></i> No reports found${filterInfo}. Try changing filters or check "Show All Record Reports".`;
            statusEl.style.display = 'block';
            statusEl.style.background = 'rgba(245, 158, 11, 0.1)';
            statusEl.style.color = '#d97706';
        } else {
            statusEl.innerHTML = `
                <i class="fas fa-check-circle"></i> 
                <span style="color:#f97316;font-weight:600;">🔔 ${alerts} Alerts</span> | 
                <span style="color:#eab308;font-weight:600;">⚠️ ${reports} Emergencies</span> | 
                <span style="color:#ef4444;font-weight:600;">🆘 ${sos} SOS</span>
                &nbsp;→&nbsp; <strong style="color:#10b981;">${allMarkers.length} markers on map</strong>
                ${filterInfo}
            `;
            statusEl.style.display = 'block';
            statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
            statusEl.style.color = '#059669';
        }
    }
}

// Function to display emergencies on the map
function displayEmergencies(alerts, reports, sos) {
  if (!map) {
    console.warn('Map not initialized yet, skipping marker rendering');
    return;
  }
  // Combine all data
  let allEmergencies = [];
  
  // Filter by emergency type
  if (filters.emergencyType === 'all' || filters.emergencyType === 'alerts') {
      allEmergencies = allEmergencies.concat(alerts);
  }
  
  if (filters.emergencyType === 'all' || filters.emergencyType === 'reports') {
      allEmergencies = allEmergencies.concat(reports);
  }
  
  if (filters.emergencyType === 'all' || filters.emergencyType === 'sos') {
      allEmergencies = allEmergencies.concat(sos);
  }
  
  // Apply additional filters
  allEmergencies = allEmergencies.filter(emergency => {
      // Filter by incident type
      if (filters.incidentType !== 'all' && emergency.type !== filters.incidentType) {
          return false;
      }
      
      // Filter by location
      if (filters.location && 
          (!emergency.location || 
           !emergency.location.toLowerCase().includes(filters.location))) {
          return false;
      }
      
      // Filter by date range
      const emergencyDate = emergency.timestamp ? 
                           (emergency.timestamp.toDate ? emergency.timestamp.toDate() : new Date(emergency.timestamp)) : 
                           null;
      
      if (emergencyDate) {
          if (filters.dateFrom && emergencyDate < filters.dateFrom) {
              return false;
          }
          
          if (filters.dateTo && emergencyDate > filters.dateTo) {
              return false;
          }
      }
      
      return true;
  });
  
  // Add markers to the map
  let skippedCount = 0;

  function parseAndValidateCoordinates(emergency) {
      let lat, lng;

      if (emergency.coordinates) {
          if (typeof emergency.coordinates.latitude !== 'undefined' && typeof emergency.coordinates.longitude !== 'undefined') {
              lat = emergency.coordinates.latitude;
              lng = emergency.coordinates.longitude;
          } else if (typeof emergency.coordinates.lat !== 'undefined' && (emergency.coordinates.lng !== undefined || emergency.coordinates.lon !== undefined)) {
              lat = emergency.coordinates.lat;
              lng = emergency.coordinates.lng ?? emergency.coordinates.lon;
          } else if (Array.isArray(emergency.coordinates) && emergency.coordinates.length >= 2) {
              lat = emergency.coordinates[0];
              lng = emergency.coordinates[1];
          }
      }
      if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') {
          lat = emergency.latitude;
          lng = emergency.longitude ?? emergency.lng;
      }

      lat = parseFloat(lat);
      lng = parseFloat(lng);

      if (isNaN(lat) || isNaN(lng)) {
          return { valid: false, reason: 'NaN' };
      }
      if (lat === 0 || lng === 0) {
          return { valid: false, reason: 'zero' };
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return { valid: false, reason: 'out_of_range' };
      }

      if (lat < PH_BOUNDS.latMin || lat > PH_BOUNDS.latMax || lng < PH_BOUNDS.lngMin || lng > PH_BOUNDS.lngMax) {
          if (lng >= PH_BOUNDS.latMin && lng <= PH_BOUNDS.latMax && lat >= PH_BOUNDS.lngMin && lat <= PH_BOUNDS.lngMax) {
              [lat, lng] = [lng, lat];
          } else {
              return { valid: false, reason: 'outside_philippines' };
          }
      }

      return { valid: true, lat, lng };
  }

  allEmergencies.forEach(emergency => {
      if (!emergency.coordinates && !emergency.location) {
          skippedCount++;
          return;
      }

      const result = parseAndValidateCoordinates(emergency);
      if (!result.valid) {
          console.warn('Invalid coordinates skipped:', { id: emergency.id, reason: result.reason, coordinates: emergency.coordinates, lat: emergency.latitude, lng: emergency.longitude });
          skippedCount++;
          return;
      }

      const latitude = result.lat;
      const longitude = result.lng;

      if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
          latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          console.warn('Invalid coordinates skipped (final check):', emergency.id, latitude, longitude);
          skippedCount++;
          return;
      }
      
      // Create marker with appropriate icon based on 3 LEGEND TYPES ONLY:
      // 1. Alert (Orange) - Created by Admin
      // 2. Emergency (Yellow) - Created by Citizens
      // 3. SOS Emergency (Red) - Created by Citizens (Critical)
      let iconClass, popupTitle, headerClass, markerColor, createdBy, legendType;

      // Color coding by the 3 legend types
      switch (emergency.emergencyType) {
          case 'alert':
              // Alert - ORANGE (Admin Created)
              iconClass = 'alert-icon';
              popupTitle = '🔔 Alert';
              headerClass = 'popup-header-alert';
              markerColor = '#f97316';  // Orange
              createdBy = 'Admin';
              legendType = 'Alert';
              break;
          case 'report':
              // Emergency - YELLOW (Citizen Created)
              iconClass = 'emergency-icon';
              popupTitle = '⚠️ Emergency';
              headerClass = 'popup-header-emergency';
              markerColor = '#eab308';  // Yellow
              createdBy = 'Citizen';
              legendType = 'Emergency';
              break;
          case 'sos':
              // SOS Emergency - RED (Citizen Created - Critical)
              iconClass = 'sos-icon';
              popupTitle = '🆘 SOS Emergency';
              headerClass = 'popup-header-sos';
              markerColor = '#ef4444';  // Red
              createdBy = 'Citizen';
              legendType = 'SOS Emergency';
              break;
          default:
              // Default to Emergency (Yellow)
              iconClass = 'emergency-icon';
              popupTitle = '⚠️ Emergency';
              headerClass = 'popup-header-emergency';
              markerColor = '#eab308';
              createdBy = 'Unknown';
              legendType = 'Emergency';
      }
      
      // FIX: className empty string stops Leaflet adding .leaflet-div-icon
      // default styles (white bg + grey border) that caused ghost ring circles.
      // All visual styling lives inside the inner div inline styles only.
      // box-sizing:border-box keeps the 24px size inclusive of the border so
      // iconAnchor:[12,12] centres the dot exactly on the coordinate.
      const isSOS = emergency.emergencyType === 'sos';
      const sosAnimation = isSOS ? 'animation:pulse-sos 1.5s infinite;' : '';
      // Outer 36×36 hit area (easier to click when markers overlap); inner 24px dot unchanged visually
      const dot =
          '<div style="width:24px;height:24px;box-sizing:border-box;border-radius:50%;background:' +
          markerColor +
          ';border:3px solid rgba(255,255,255,0.95);box-shadow:0 2px 8px rgba(0,0,0,0.45);' +
          sosAnimation +
          '"></div>';
      const icon = L.divIcon({
          className: '',
          iconSize: [36, 36],
          iconAnchor: [18, 18],
          html:
              '<div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;">' +
              dot +
              '</div>'
      });
      
      // Format the timestamp
      let timeString = 'Unknown time';
      if (emergency.timestamp) {
          const date = emergency.timestamp.toDate ? 
                      emergency.timestamp.toDate() : 
                      new Date(emergency.timestamp);
          timeString = date.toLocaleString();
      }
      
      const isOpen = isOpenIncidentForMap(emergency);
      const statusClass = isOpen ? 'status-active' : 'status-inactive';
      const statusText = isOpen
        ? (emergency.responderStatus === 'accepted' || emergency.isAcknowledged ? 'ACCEPTED / ONGOING' : (emergency.status || 'ACTIVE').toUpperCase())
        : 'RESOLVED';
      
      const hasAssignedTeam =
        teamAssignmentPresent(emergency) ||
        !!(emergency.assignedTeamName && String(emergency.assignedTeamName).trim());
      const assignedTeamName = emergency.assignedTeamName || 'Unknown Team';
      
      // Get type label and icon based on the 3 legend types
      let typeIcon, typeLabel, typeBadgeColor;
      
      switch (emergency.emergencyType) {
          case 'alert':
              typeIcon = '🔔';
              typeLabel = 'ALERT';
              typeBadgeColor = '#f97316';  // Orange
              break;
          case 'report':
              typeIcon = '⚠️';
              typeLabel = 'EMERGENCY';
              typeBadgeColor = '#eab308';  // Yellow
              break;
          case 'sos':
              typeIcon = '🆘';
              typeLabel = 'SOS EMERGENCY';
              typeBadgeColor = '#ef4444';  // Red
              break;
          default:
              typeIcon = '⚠️';
              typeLabel = 'EMERGENCY';
              typeBadgeColor = '#eab308';
      }

      // Get incident category if available
      const incidentCategory = emergency.type || 'Not specified';

      // Create popup content with modern HTML
      const popupContent = `
          <div class="popup-container">
              <div class="popup-header ${headerClass}">
                  <h3 class="popup-title">${typeIcon} ${typeLabel}</h3>
                  <span class="popup-status ${statusClass}">${statusText}</span>
              </div>
              <div class="popup-content">
                  <!-- Report Type Badge -->
                  <div class="popup-detail" style="background: ${typeBadgeColor}15; padding: 10px; border-radius: 8px; border-left: 4px solid ${typeBadgeColor};">
                      <span class="popup-icon"><i class="fas fa-tag" style="color: ${typeBadgeColor};"></i></span>
                      <span class="popup-label" style="color: ${typeBadgeColor};">Report Type:</span>
                      <span class="popup-value" style="color: ${typeBadgeColor}; font-weight: 700;">
                          ${typeIcon} ${typeLabel}
                      </span>
                  </div>
                  <div class="popup-detail">
                      <span class="popup-icon"><i class="fas fa-user-tag"></i></span>
                      <span class="popup-label">Created By:</span>
                      <span class="popup-value">${createdBy}</span>
                  </div>
                  ${incidentCategory !== 'Not specified' ? `
                  <div class="popup-detail">
                      <span class="popup-icon"><i class="fas fa-folder"></i></span>
                      <span class="popup-label">Category:</span>
                      <span class="popup-value">${incidentCategory}</span>
                  </div>
                  ` : ''}
                  
                  <div class="popup-detail">
                      <span class="popup-icon"><i class="fas fa-map-marker-alt"></i></span>
                      <span class="popup-label">Location:</span>
                      <span class="popup-value">${emergency.location || 'Unknown'}</span>
                  </div>
                  <div class="popup-detail">
                      <span class="popup-icon"><i class="far fa-clock"></i></span>
                      <span class="popup-label">Time:</span>
                      <span class="popup-value">${timeString}</span>
                  </div>
                  ${emergency.reportedBy || emergency.reportedByName ? `
                      <div class="popup-detail">
                          <span class="popup-icon"><i class="fas fa-user"></i></span>
                          <span class="popup-label">Reported By:</span>
                          <span class="popup-value">${emergency.reportedByName || emergency.reportedBy || 'Unknown'}</span>
                      </div>
                  ` : ''}
                  ${emergency.reportedByContactNumber ? `
                      <div class="popup-detail">
                          <span class="popup-icon"><i class="fas fa-phone"></i></span>
                          <span class="popup-label">Contact:</span>
                          <span class="popup-value">
                              <a href="tel:${emergency.reportedByContactNumber}" style="color: #3b82f6; text-decoration: none;">
                                  ${emergency.reportedByContactNumber}
                              </a>
                          </span>
                      </div>
                  ` : ''}
                  ${hasAssignedTeam ? `
                      <div class="popup-detail" style="background: #d5f5e3; padding: 10px; border-radius: 8px; border-left: 4px solid #27ae60;">
                          <span class="popup-icon"><i class="fas fa-users" style="color: #27ae60;"></i></span>
                          <span class="popup-label" style="color: #27ae60;">Assigned Team:</span>
                          <span class="popup-value" style="color: #27ae60; font-weight: 600;">${assignedTeamName}</span>
                      </div>
                  ` : ''}
                  ${emergency.description || emergency.details || emergency.message ? `
                      <div class="popup-description">
                          <strong>Details:</strong><br>
                          ${emergency.description || emergency.details || emergency.message}
                      </div>
                  ` : ''}
                  <div class="popup-detail" style="font-size: 11px; color: #9ca3af;">
                      <span class="popup-icon"><i class="fas fa-fingerprint"></i></span>
                      <span class="popup-label">ID:</span>
                      <span class="popup-value" style="font-family: monospace;">${emergency.id}</span>
                  </div>
              </div>
              <div class="popup-actions">
                  <button class="popup-button" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving', '_blank')">
                      <i class="fas fa-directions"></i> Directions
                  </button>
                  ${isOpen ? `
                      <button class="popup-button assign-team-btn" 
                              style="background: linear-gradient(135deg, #3b82f6, #2563eb);"
                              data-id="${emergency.id}" 
                              data-type="${emergency.emergencyType}"
                              data-lat="${latitude}"
                              data-lng="${longitude}"
                              data-location="${escapeAttr(emergency.location || '')}"
                              data-emergency-type="${escapeAttr(emergency.type || 'Emergency')}">
                          <i class="fas fa-paper-plane"></i> ${hasAssignedTeam ? 'Reassign Team' : 'Assign Team'}
                      </button>
                  ` : ''}
                  ${isOpen ? `
                      <button class="popup-button resolve-emergency" 
                              style="background-color: #e74c3c;"
                              data-id="${emergency.id}" 
                              data-type="${emergency.emergencyType}">
                          <i class="fas fa-check"></i> Resolve
                      </button>
                  ` : ''}
              </div>
          </div>
      `;
      
      // Create and add the marker - L.marker([lat, lng]) NOT [lng, lat]
      const marker = L.marker([latitude, longitude], { icon: icon })
          .addTo(map)
          .bindPopup(popupContent, {
              maxWidth: 380,
              minWidth: 300,
              maxHeight: 520,
              className: 'custom-popup',
              autoPan: true,
              autoPanPadding: [48, 48],
              keepInView: true,
              closeButton: true
          });

      // Scope buttons to this popup only (avoid wrong marker / duplicate handlers)
      marker.on('popupopen', function () {
          const root = this.getPopup()?.getElement?.();
          if (!root) return;

          const resolveButton = root.querySelector('.resolve-emergency');
          if (resolveButton) {
              resolveButton.addEventListener(
                  'click',
                  function onResolve() {
                      const id = this.getAttribute('data-id');
                      const type = this.getAttribute('data-type');
                      markEmergencyAsResolved(id, type);
                  },
                  { once: true }
              );
          }

          const assignButton = root.querySelector('.assign-team-btn');
          if (assignButton) {
              assignButton.addEventListener(
                  'click',
                  function onAssign() {
                      const emergencyData = {
                          id: this.getAttribute('data-id'),
                          type: this.getAttribute('data-type'),
                          lat: this.getAttribute('data-lat'),
                          lng: this.getAttribute('data-lng'),
                          location: this.getAttribute('data-location'),
                          emergencyType: this.getAttribute('data-emergency-type')
                      };
                      openAssignTeamModal(emergencyData);
                  },
                  { once: true }
              );
          }
      });
      
      // Add to markers array for later removal
      allMarkers.push(marker);
  });
  
  // Display count
  console.log(`=== Map Display Summary ===`);
  console.log(`Total emergencies after filters: ${allEmergencies.length}`);
  console.log(`Markers displayed: ${allMarkers.length}`);
  console.log(`Skipped (no/invalid coordinates): ${skippedCount}`);
  
  if (pendingFocusFromUrl) {
    const { lat, lng, zoom } = pendingFocusFromUrl;
    map.setView([lat, lng], zoom || 16);
    pendingFocusFromUrl = null;
    pendingLocationGeocodeFallback = null;
  } else if (allMarkers.length > 0) {
    const group = L.featureGroup(allMarkers);
    map.fitBounds(group.getBounds(), { padding: [50, 50] });
    pendingLocationGeocodeFallback = null;
  } else if (allEmergencies.length > 0) {
    console.log('Warning: Emergencies found but no valid coordinates to display');
  }

  if (allMarkers.length === 0 && pendingLocationGeocodeFallback) {
    const q = pendingLocationGeocodeFallback;
    pendingLocationGeocodeFallback = null;
    geocodeAndNavigate(q);
  }
}

// Function to clear all filters
export function clearFilters() {
  // Reset filter values
  filters = {
    emergencyType: 'all',
    incidentType: 'all',
    location: '',
    dateFrom: null,
    dateTo: null,
    activeOnly: false
  };
  
  // Reset UI elements
  document.getElementById('emergency-type-filter').value = 'all';
  document.getElementById('incident-filter').value = 'all';
  document.getElementById('location-search').value = '';
  document.getElementById('date-from').value = '';
  document.getElementById('date-to').value = '';
  document.getElementById('active-only').checked = false;
  
  // Reset map to default Negros Island view
  map.setView(defaultMapPosition, defaultZoom);
  
  // Show success message
  console.log('Filters cleared');
  
  // Re-subscribe with default filters (activeOnly changed)
  setupEmergencyListeners();
}

// Helper function to clear all markers
function clearAllMarkers() {
  allMarkers.forEach(marker => map.removeLayer(marker));
  allMarkers = [];
}

// Helper function to show/hide loading indicator
function showLoading(isLoading) {
  const loadingIndicator = document.getElementById('loading-indicator');
  loadingIndicator.style.display = isLoading ? 'block' : 'none';
}

function nominatimDistanceToAnchor(lat, lon) {
  const dLat = parseFloat(lat) - GEOCODE_ANCHOR.lat;
  const dLon = parseFloat(lon) - GEOCODE_ANCHOR.lng;
  return dLat * dLat + dLon * dLon;
}

// Function to geocode an address and navigate to it
async function geocodeAndNavigate(address) {
  if (!address || address.trim() === '') {
    map.setView(defaultMapPosition, defaultZoom);
    return;
  }

  try {
    showLoading(true);

    const trimmed = address.trim();
    const biasedQuery =
      /philippines|negros|la carlota|visayas/i.test(trimmed) || trimmed.length > 60
        ? trimmed
        : `${trimmed}${GEOCODE_SUFFIX}`;

    const url =
      `https://nominatim.openstreetmap.org/search?format=json&countrycodes=ph&limit=8&q=${encodeURIComponent(biasedQuery)}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en',
      },
    });
    const data = await response.json();

    if (data && data.length > 0) {
      let best = data[0];
      let bestScore = nominatimDistanceToAnchor(best.lat, best.lon);
      for (let i = 1; i < data.length; i++) {
        const s = nominatimDistanceToAnchor(data[i].lat, data[i].lon);
        if (s < bestScore) {
          bestScore = s;
          best = data[i];
        }
      }
      map.setView([parseFloat(best.lat), parseFloat(best.lon)], 15);
      console.log(`Geocoded (PH-biased): ${address}`);
    } else {
      console.log(`Could not find location: ${address}`);
      alert('Location not found. Try a more specific address or open History for coordinates.');
    }
  } catch (error) {
    console.error('Error geocoding address:', error);
    alert('Error finding location. Please try again.');
  } finally {
    showLoading(false);
  }
}

// Function to navigate to user's current location
function navigateToCurrentLocation() {
  if (navigator.geolocation) {
    showLoading(true);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userLocation = [position.coords.latitude, position.coords.longitude];
        map.setView(userLocation, 13);
        console.log('Navigated to current location');
        showLoading(false);
      },
      (error) => {
        console.error('Error getting current location:', error);
        map.setView(defaultMapPosition, defaultZoom);
        showLoading(false);
      },
      { timeout: 10000 }
    );
  } else {
    console.log('Geolocation not supported by this browser');
    map.setView(defaultMapPosition, defaultZoom);
  }
}

// Load available teams from Firebase
export async function loadAvailableTeams() {
    try {
        const teamsRef = collection(firestore, 'Teams');
        const q = query(teamsRef, where('status', '==', 'available'));
        const snapshot = await getDocs(q);
        
        availableTeams = [];
        snapshot.forEach(doc => {
            availableTeams.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        console.log('Loaded available teams:', availableTeams.length);
        return availableTeams;
    } catch (error) {
        console.error('Error loading teams:', error);
        return [];
    }
}

// Open the assign team modal
export async function openAssignTeamModal(emergencyData) {
    currentEmergency = emergencyData;
    
    // Load fresh team list
    await loadAvailableTeams();
    
    // Get the modal elements
    const modal = document.getElementById('assignTeamModal');
    const teamSelect = document.getElementById('teamSelectDropdown');
    const emergencyInfo = document.getElementById('assignEmergencyInfo');
    
    if (!modal || !teamSelect) {
        alert('Assignment modal not found. Please refresh the page.');
        return;
    }
    
    // Populate emergency info
    if (emergencyInfo) {
        emergencyInfo.innerHTML = `
            <div style="background: #f3f4f6; padding: 12px; border-radius: 8px; margin-bottom: 16px;">
                <p style="margin: 0 0 8px;"><strong>Type:</strong> ${emergencyData.emergencyType}</p>
                <p style="margin: 0;"><strong>Location:</strong> ${emergencyData.location || 'Unknown'}</p>
            </div>
        `;
    }
    
    // Populate team dropdown
    teamSelect.innerHTML = '<option value="">-- Select a Team --</option>';
    
    if (availableTeams.length === 0) {
        teamSelect.innerHTML += '<option value="" disabled>No available teams</option>';
    } else {
        // Group teams by type
        const teamsByType = {};
        availableTeams.forEach(team => {
            const type = team.type || 'other';
            if (!teamsByType[type]) {
                teamsByType[type] = [];
            }
            teamsByType[type].push(team);
        });
        
        // Create optgroups
        Object.keys(teamsByType).sort().forEach(type => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = type.charAt(0).toUpperCase() + type.slice(1) + ' Teams';
            
            teamsByType[type].forEach(team => {
                const option = document.createElement('option');
                option.value = team.id;
                option.textContent = `${team.name} (${team.members} members)`;
                option.dataset.teamName = team.name;
                option.dataset.teamType = team.type;
                option.dataset.teamContact = team.contact || '';
                optgroup.appendChild(option);
            });
            
            teamSelect.appendChild(optgroup);
        });
    }
    
    // Must be flex (not block) so .modal’s align-items/justify-content center the dialog
    modal.style.display = 'flex';
}

// Assign team to emergency
export async function assignTeamToEmergency() {
    const teamSelect = document.getElementById('teamSelectDropdown');
    const teamId = teamSelect.value;
    
    if (!teamId) {
        alert('Please select a team to assign.');
        return;
    }
    
    if (!currentEmergency) {
        alert('No emergency selected.');
        return;
    }
    
    try {
        // Get team details
        const selectedOption = teamSelect.options[teamSelect.selectedIndex];
        const teamName = selectedOption.dataset.teamName;
        const teamType = selectedOption.dataset.teamType;
        const teamContact = selectedOption.dataset.teamContact;
        
        const t = (currentEmergency.type || currentEmergency.emergencyType || '').toString().toLowerCase();
        let collectionName;
        switch (t) {
            case 'alert': collectionName = 'Alerts'; break;
            case 'report': collectionName = 'Reports'; break;
            case 'sos': collectionName = 'SOS'; break;
            default: collectionName = 'Alerts';
        }
        
        const emergencyRef = doc(firestore, collectionName, currentEmergency.id);
        const priorSnap = await getDoc(emergencyRef);
        const prior = priorSnap.exists() ? priorSnap.data() : {};
        const prevTeamId = prior.assignedTeamId || prior.assignedTeam;
        if (prevTeamId && prevTeamId !== teamId) {
          await releasePreviousTeamOnReassign(prevTeamId, currentEmergency.id, 'map_assign');
        }

        // Update the emergency document with assigned team
        await updateDoc(emergencyRef, {
            assignedTeam: teamId,
            assignedTeamId: teamId,
            assignedTeamName: teamName,
            assignedTeamType: teamType,
            assignedTeamContact: teamContact,
            assignedAt: serverTimestamp(),
            assignedBy: 'admin',
            status: 'dispatched'
        });
        
        // Update the team status to 'on-mission'
        const teamRef = doc(firestore, 'Teams', teamId);
        await updateDoc(teamRef, {
            status: 'on-mission',
            currentMission: currentEmergency.id,
            missionType: currentEmergency.type,
            missionLocation: currentEmergency.location,
            missionCoordinates: {
                latitude: parseFloat(currentEmergency.lat),
                longitude: parseFloat(currentEmergency.lng)
            },
            missionStartedAt: serverTimestamp()
        });
        
        // Close modal
        document.getElementById('assignTeamModal').style.display = 'none';
        
        // Show success message
        alert(`Team "${teamName}" has been assigned to this emergency!\n\nThe team will be notified and can see the location on their responder app.`);
        
        // Send SMS to assigned team members + citizen notice (fire-and-forget)
        try {
            const fullEmergencySnap = await getDoc(emergencyRef);
            const eData = fullEmergencySnap.exists() ? fullEmergencySnap.data() : {};

            const phones = await getPhonesForTeamDispatch(teamId, teamName);

            if (phones.length > 0) {
                const citizenData = {
                    reportedByName: eData.reportedByName || eData.reportedBy || 'Unknown',
                    contactNumber: eData.contactNumber || eData.reportedByContactNumber || 'N/A',
                    location: eData.location || 'Unknown location',
                    coordinates: eData.coordinates || null,
                    type: eData.type || currentEmergency.type || 'Emergency',
                    additionalInfo: eData.details || eData.additionalInfo || '',
                };

                smsService.sendTeamDispatchSMS(citizenData, { name: teamName, type: teamType }, phones)
                    .then(result => console.log('[Map] Dispatch SMS result:', result))
                    .catch(err => console.error('[Map] Dispatch SMS error:', err));
            }

            const citizenPhone =
                eData.contactNumber || eData.reportedByContactNumber || '';
            if (citizenPhone && String(citizenPhone).trim() && citizenPhone !== 'N/A') {
                const caseType =
                    t === 'sos' ? 'SOS' : t === 'report' ? 'emergency report' : 'alert';
                notifyCitizenTeamAssigned(citizenPhone, {
                    teamName,
                    caseType,
                    location: eData.location || currentEmergency.location || '',
                    refId: currentEmergency.id,
                })
                    .then((r) => console.log('[Map] Citizen team-assigned SMS:', r))
                    .catch((err) => console.error('[Map] Citizen team-assigned SMS error:', err));
            }
        } catch (smsErr) {
            console.error('[Map] SMS dispatch error (non-blocking):', smsErr);
        }
        
        // Map updates automatically via real-time Firestore listener
        
    } catch (error) {
        console.error('Error assigning team:', error);
        alert('Error assigning team. Please try again.');
    }
}

// Make functions globally available
window.openAssignTeamModal = openAssignTeamModal;
window.assignTeamToEmergency = assignTeamToEmergency;

// Add this function after loadAllEmergencies
export async function markEmergencyAsResolved(id, type) {
  try {
    showLoading(true);
    
    // Determine collection name based on type
    let collectionName;
    switch(type) {
      case 'alert':
        collectionName = 'Alerts';
        break;
      case 'report':
        collectionName = 'Reports';
        break;
      case 'sos':
        collectionName = 'SOS';
        break;
      default:
        throw new Error(`Unknown emergency type: ${type}`);
    }
    
    const emergencyRef = doc(firestore, collectionName, id);
    const beforeSnap = await getDoc(emergencyRef);
    const beforeData = beforeSnap.exists() ? beforeSnap.data() : {};

    await updateDoc(emergencyRef, {
      status: 'inactive',
      isResolved: true,
      resolvedAt: new Date(),
      resolvedBy: 'admin'
    });

    await releaseAssignedTeamAfterResolve(id, beforeData, 'map_resolve');
    
    console.log(`Successfully marked ${type} ${id} as resolved`);
    
    adminLogger.log('resolve_incident', 'Incident', id, {
      type,
      status: 'inactive'
    });
    
    return true;
  } catch (error) {
    console.error(`Error marking emergency as resolved:`, error);
    alert(`Failed to resolve ${type}: ${error.message}`);
    return false;
  } finally {
    showLoading(false);
  }
}