import { 
  firestore,
  collection, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs, 
  onSnapshot, 
  serverTimestamp 
} from './firebase-api.js';

document.addEventListener('DOMContentLoaded', () => {
  initializeMetrics();
  setupMetricsListeners();
  setupRecentActivityListener();
  setTimeout(() => loadHighRiskAnalytics(), 2000);
});

// Initialize metrics with initial values
async function initializeMetrics() {
  try {
    // Fetch all metrics at once
    const [
      activeIncidents,
      deployedUnits,
      individualsAssisted,
      resolvedToday,
      highAlertAreas
    ] = await Promise.all([
      countActiveIncidents(),
      countDeployedUnits(),
      countIndividualsAssisted(),
      countResolvedIncidentsToday(),
      countHighAlertAreas()
    ]);
    
    // Update the dashboard cards
    updateDashboardCard('active-incidents', activeIncidents);
    updateDashboardCard('deployed-units', deployedUnits);
    updateDashboardCard('individuals-assisted', individualsAssisted);
    updateDashboardCard('resolved-incidents', resolvedToday);
    updateDashboardCard('high-alert-areas', highAlertAreas);
    
    console.log('Dashboard metrics initialized successfully');
  } catch (error) {
    console.error('Error initializing dashboard metrics:', error);
  }
}

// Set up real-time listeners for metrics
let unsubReportsMetrics, unsubAlertsMetrics, unsubSosMetrics;
let refreshTimeout;

function debouncedRefreshMetrics() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => {
    refreshMetrics();
  }, 1000); // 1s debounce to prevent multiple simultaneous queries
}

function setupMetricsListeners() {
  // FIX: Unsubscribe previous listeners to prevent stacking memory leaks
  if (unsubReportsMetrics) unsubReportsMetrics();
  if (unsubAlertsMetrics) unsubAlertsMetrics();
  if (unsubSosMetrics) unsubSosMetrics();

  // Listen for changes in Reports collection
  const reportsRef = collection(firestore, 'Reports');
  unsubReportsMetrics = onSnapshot(reportsRef, () => {
    debouncedRefreshMetrics();
  });
  
  // Listen for changes in Alerts collection
  const alertsRef = collection(firestore, 'Alerts');
  unsubAlertsMetrics = onSnapshot(alertsRef, () => {
    debouncedRefreshMetrics();
  });
  
  // Listen for changes in SOS collection
  const sosRef = collection(firestore, 'SOS');
  unsubSosMetrics = onSnapshot(sosRef, () => {
    debouncedRefreshMetrics();
  });
}

// Refresh all metrics when data changes
async function refreshMetrics() {
  try {
    const [
      activeIncidents,
      deployedUnits,
      individualsAssisted,
      resolvedToday,
      highAlertAreas
    ] = await Promise.all([
      countActiveIncidents(),
      countDeployedUnits(),
      countIndividualsAssisted(),
      countResolvedIncidentsToday(),
      countHighAlertAreas()
    ]);
    
    // Update the dashboard cards
    updateDashboardCard('active-incidents', activeIncidents);
    updateDashboardCard('deployed-units', deployedUnits);
    updateDashboardCard('individuals-assisted', individualsAssisted);
    updateDashboardCard('resolved-incidents', resolvedToday);
    updateDashboardCard('high-alert-areas', highAlertAreas);
  } catch (error) {
    console.error('Error refreshing metrics:', error);
  }
}

// Count all active incidents (Reports, Alerts, and SOSs)
async function countActiveIncidents() {
  try {
    // Count active reports
    const reportsRef = collection(firestore, 'Reports');
    const reportsQuery = query(reportsRef, where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active']));
    const reportsSnapshot = await getDocs(reportsQuery);
    const activeReports = reportsSnapshot.size;
    
    // Count active alerts
    const alertsRef = collection(firestore, 'Alerts');
    const alertsQuery = query(alertsRef, where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active']));
    const alertsSnapshot = await getDocs(alertsQuery);
    const activeAlerts = alertsSnapshot.size;
    
    // Count active SOS
    const sosRef = collection(firestore, 'SOS');
    const sosQuery = query(sosRef, where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active']));
    const sosSnapshot = await getDocs(sosQuery);
    const activeSOS = sosSnapshot.size;
    
    // Return total count
    return activeReports + activeAlerts + activeSOS;
  } catch (error) {
    console.error('Error counting active incidents:', error);
    return 0;
  }
}

// Count individuals assisted (resolved incidents)
async function countIndividualsAssisted() {
  try {
    // Count resolved reports
    const reportsRef = collection(firestore, 'Reports');
    const reportsQuery = query(
      reportsRef, 
      where('status', '==', 'resolved'),
      where('isResolved', '==', true)
    );
    const reportsSnapshot = await getDocs(reportsQuery);
    const resolvedReports = reportsSnapshot.size;
    
    // Count resolved alerts
    const alertsRef = collection(firestore, 'Alerts');
    const alertsQuery = query(
      alertsRef, 
      where('status', '==', 'resolved'),
      where('isResolved', '==', true)
    );
    const alertsSnapshot = await getDocs(alertsQuery);
    const resolvedAlerts = alertsSnapshot.size;
    
    // Count resolved SOS
    const sosRef = collection(firestore, 'SOS');
    const sosQuery = query(
      sosRef, 
      where('status', '==', 'resolved'),
      where('isResolved', '==', true)
    );
    const sosSnapshot = await getDocs(sosQuery);
    const resolvedSOS = sosSnapshot.size;
    
    // Return total count
    return resolvedReports + resolvedAlerts + resolvedSOS;
  } catch (error) {
    console.error('Error counting individuals assisted:', error);
    return 0;
  }
}

// Count currently deployed units (teams on active missions)
async function countDeployedUnits() {
  try {
    const teamsRef = collection(firestore, 'Teams');
    const deployedQuery = query(teamsRef, where('status', '==', 'on-mission'));
    const deployedSnapshot = await getDocs(deployedQuery);
    return deployedSnapshot.size;
  } catch (error) {
    console.error('Error counting deployed units:', error);
    return 0;
  }
}

// Replace the countResolvedIncidentsToday function with this improved version

async function countResolvedIncidentsToday() {
  try {
    // Get today's start timestamp (12:00 AM)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = new Date(today);
    
    // Get today's end timestamp (11:59 PM)
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    
    console.log(`Counting resolved incidents between ${todayStart.toISOString()} and ${todayEnd.toISOString()}`);
    
    // REPORTS: Get all inactive+resolved reports first, then filter by date client-side
    const reportsRef = collection(firestore, 'Reports');
    const reportsQuery = query(
      reportsRef, 
      where('status', '==', 'resolved'),
      where('isResolved', '==', true)
    );
    const reportsSnapshot = await getDocs(reportsQuery);
    
    // Count reports that were resolved today by checking timestamps client-side
    let reportsResolvedToday = 0;
    reportsSnapshot.forEach(doc => {
      const data = doc.data();
      
      // Check different possible timestamp fields
      let resolvedTime = null;
      if (data.resolvedAt && data.resolvedAt.toDate) {
        resolvedTime = data.resolvedAt.toDate();
      } else if (data.resolvedAt) {
        // Handle if resolvedAt is a regular Date or timestamp
        resolvedTime = new Date(data.resolvedAt);
      } else if (data.updatedAt && data.updatedAt.toDate) {
        resolvedTime = data.updatedAt.toDate();
      } else if (data.updatedAt) {
        resolvedTime = new Date(data.updatedAt);
      }
      
      if (resolvedTime && resolvedTime >= todayStart && resolvedTime <= todayEnd) {
        reportsResolvedToday++;
        console.log(`Counted resolved report: ${doc.id}, resolved at ${resolvedTime}`);
      }
    });
    
    console.log(`Found ${reportsResolvedToday} reports resolved today`);
    
    // Do the same for alerts and SOS with the same pattern
    
    // ALERTS
    const alertsRef = collection(firestore, 'Alerts');
    const alertsQuery = query(
      alertsRef, 
      where('status', '==', 'resolved'),
      where('isResolved', '==', true)
    );
    const alertsSnapshot = await getDocs(alertsQuery);
    
    let alertsResolvedToday = 0;
    alertsSnapshot.forEach(doc => {
      const data = doc.data();
      let resolvedTime = null;
      
      if (data.resolvedAt && data.resolvedAt.toDate) {
        resolvedTime = data.resolvedAt.toDate();
      } else if (data.resolvedAt) {
        resolvedTime = new Date(data.resolvedAt);
      } else if (data.updatedAt && data.updatedAt.toDate) {
        resolvedTime = data.updatedAt.toDate();
      } else if (data.updatedAt) {
        resolvedTime = new Date(data.updatedAt);
      }
      
      if (resolvedTime && resolvedTime >= todayStart && resolvedTime <= todayEnd) {
        alertsResolvedToday++;
      }
    });
    
    console.log(`Found ${alertsResolvedToday} alerts resolved today`);
    
    // SOS
    const sosRef = collection(firestore, 'SOS');
    const sosQuery = query(
      sosRef, 
      where('status', '==', 'resolved'),
      where('isResolved', '==', true)
    );
    const sosSnapshot = await getDocs(sosQuery);
    
    let sosResolvedToday = 0;
    sosSnapshot.forEach(doc => {
      const data = doc.data();
      let resolvedTime = null;
      
      if (data.resolvedAt && data.resolvedAt.toDate) {
        resolvedTime = data.resolvedAt.toDate();
      } else if (data.resolvedAt) {
        resolvedTime = new Date(data.resolvedAt);
      } else if (data.updatedAt && data.updatedAt.toDate) {
        resolvedTime = data.updatedAt.toDate();
      } else if (data.updatedAt) {
        resolvedTime = new Date(data.updatedAt);
      }
      
      if (resolvedTime && resolvedTime >= todayStart && resolvedTime <= todayEnd) {
        sosResolvedToday++;
      }
    });
    
    console.log(`Found ${sosResolvedToday} SOS resolved today`);
    
    // Return total count
    const totalResolved = reportsResolvedToday + alertsResolvedToday + sosResolvedToday;
    console.log(`Total resolved today: ${totalResolved}`);
    return totalResolved;
  } catch (error) {
    console.error('Error counting resolved incidents today:', error);
    console.error('Error details:', error.stack);
    return 0;
  }
}

// Count areas with high alert
async function countHighAlertAreas() {
  try {
    // Get today's start timestamp (12:00 AM)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = new Date(today);
    
    // Get today's end timestamp (11:59 PM)
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const todayEndTimestamp = new Date(todayEnd);
    
    // Unique locations with alerts/SOS today
    const uniqueLocations = new Set();
    
    // Get alerts from today
    const alertsRef = collection(firestore, 'Alerts');
    const alertsQuery = query(
      alertsRef,
      where('timestamp', '>=', todayStart),
      where('timestamp', '<=', todayEndTimestamp)
    );
    const alertsSnapshot = await getDocs(alertsQuery);
    
    // Extract locations from alerts
    alertsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.location) {
        uniqueLocations.add(data.location);
      }
    });
    
    // Get SOS from today
    const sosRef = collection(firestore, 'SOS');
    const sosQuery = query(
      sosRef,
      where('timestamp', '>=', todayStart),
      where('timestamp', '<=', todayEndTimestamp)
    );
    const sosSnapshot = await getDocs(sosQuery);
    
    // Extract locations from SOS
    sosSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.location) {
        uniqueLocations.add(data.location);
      }
    });
    
    // Return count of unique locations
    return uniqueLocations.size;
  } catch (error) {
    console.error('Error counting high alert areas:', error);
    return 0;
  }
}

// Update a dashboard card with new value
function updateDashboardCard(cardId, value) {
  // Map cardId to the corresponding element in the HTML
  const cardMapping = {
    'active-incidents': 0,
    'deployed-units': 1,
    'individuals-assisted': 2,
    'resolved-incidents': 3,
    'high-alert-areas': 4
  };
  
  // Get all overview cards
  const cards = document.querySelectorAll('.overview-card');
  
  // Find the target card
  const cardIndex = cardMapping[cardId];
  if (cardIndex !== undefined && cards[cardIndex]) {
    const valueElement = cards[cardIndex].querySelector('h3');
    if (valueElement) {
      valueElement.textContent = value;
    }
  }
}

// Set up real-time listener for recent activity (SOS + admin Alerts + citizen Reports)
let unsubRecentSos, unsubRecentAlerts, unsubRecentReports;

function setupRecentActivityListener() {
  const recentActivityList = document.querySelector('.recent-activity ul');
  if (!recentActivityList) return;

  // FIX: Unsubscribe previous listeners
  if (unsubRecentSos) unsubRecentSos();
  if (unsubRecentAlerts) unsubRecentAlerts();
  if (unsubRecentReports) unsubRecentReports();

  const sosRef = collection(firestore, 'SOS');
  const alertsRef = collection(firestore, 'Alerts');
  const reportsRef = collection(firestore, 'Reports');

  const sosQ = query(sosRef, orderBy('timestamp', 'desc'), limit(5));
  const alertsQ = query(alertsRef, orderBy('timestamp', 'desc'), limit(5));
  const reportsQ = query(reportsRef, orderBy('timestamp', 'desc'), limit(5));

  let lastSos = [];
  let lastAlerts = [];
  let lastReports = [];

  function mapSosDoc(data) {
    let activityText = '';
    let icon = '';
    if (data.status === 'pending') {
      activityText = `SOS Emergency reported in ${data.location || 'Unknown location'}`;
      icon = 'exclamation-triangle';
    } else if (data.status === 'dispatched' || data.status === 'ongoing') {
      activityText = `SOS Emergency active/ongoing in ${data.location || 'Unknown location'}`;
      icon = 'hand-paper';
    } else {
      activityText = `SOS Emergency resolved in ${data.location || 'Unknown location'}`;
      icon = 'check-circle';
    }
    let timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();
    if (data.status === 'resolved' && data.resolvedAt) {
      timestamp = data.resolvedAt?.toDate ? data.resolvedAt.toDate() : new Date();
    }
    return { id: data.id, source: 'sos', text: activityText, icon, timestamp };
  }

  function mapAlertDoc(data) {
    const type = data.type || 'Alert';
    const loc = data.location || 'Unknown location';
    const activityText = `Admin alert (${type}): ${loc}`;
    const timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();
    return { id: data.id, source: 'alert', text: activityText, icon: 'bullhorn', timestamp };
  }

  function mapReportDoc(data) {
    const type = data.type || 'Emergency';
    const loc = data.location || 'Unknown location';
    const activityText = `Citizen report (${type}): ${loc}`;
    const timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();
    return { id: data.id, source: 'report', text: activityText, icon: 'clipboard-list', timestamp };
  }

  function mergeAndRender() {
    const activities = [
      ...lastSos.map(mapSosDoc),
      ...lastAlerts.map(mapAlertDoc),
      ...lastReports.map(mapReportDoc),
    ];
    if (activities.length === 0) {
      recentActivityList.innerHTML =
        '<li><span class="activity-text" style="color:#aaa;">No recent activity</span></li>';
      return;
    }
    updateRecentActivityUI(activities, recentActivityList);
  }

  unsubRecentSos = onSnapshot(
    sosQ,
    (snapshot) => {
      // FIX: Replace arrays immediately using map format
      lastSos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      mergeAndRender();
    },
    (err) => console.error('Recent activity SOS listener:', err)
  );

  unsubRecentAlerts = onSnapshot(
    alertsQ,
    (snapshot) => {
      // FIX: Replace arrays immediately using map format
      lastAlerts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      mergeAndRender();
    },
    (err) => console.error('Recent activity Alerts listener:', err)
  );

  unsubRecentReports = onSnapshot(
    reportsQ,
    (snapshot) => {
      // FIX: Replace arrays immediately using map format
      lastReports = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      mergeAndRender();
    },
    (err) => console.error('Recent activity Reports listener:', err)
  );
}

// Update the recent activity UI
function updateRecentActivityUI(allActivity, listElement) {
  // Sort all activities by timestamp (most recent first)
  allActivity.sort((a, b) => b.timestamp - a.timestamp);
  
  // Take only the 5 most recent activities
  const recentActivities = allActivity.slice(0, 5);
  
  // Clear the list
  listElement.innerHTML = '';
  
  // Add each activity to the list
  recentActivities.forEach(activity => {
    const li = document.createElement('li');
    
    // Format the time
    const timeAgo = formatTimeAgo(activity.timestamp);
    
    li.innerHTML = `
      <span class="activity-icon"><i class="fas fa-${activity.icon}"></i></span>
      <span class="activity-text">${activity.text}</span>
      <span class="activity-time">${timeAgo}</span>
    `;
    
    listElement.appendChild(li);
  });
}

// Format time elapsed since the timestamp
function formatTimeAgo(timestamp) {
  const now = new Date();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMinutes < 1) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else {
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }
}

// ==============================
// HIGH-RISK AREA ANALYTICS (Issue 13)
// ==============================

/** Last-known Firestore coordinates per analytics bucket key (for map deep links). */
function pinCoordinatesFromDoc(data) {
  const c = data.coordinates;
  if (!c || typeof c !== 'object') return null;
  const lat = parseFloat(c.latitude ?? c.lat);
  const lng = parseFloat(c.longitude ?? c.lng ?? c.lon);
  if (Number.isNaN(lat) || Number.isNaN(lng) || (lat === 0 && lng === 0)) return null;
  if (lat < 4.5 || lat > 21.5 || lng < 116 || lng > 127) return null;
  return { lat, lng };
}

function recordLocationPin(locationPins, locKey, data) {
  const pin = pinCoordinatesFromDoc(data);
  if (pin) locationPins[locKey] = pin;
}

async function loadHighRiskAnalytics() {
  try {
    const locationCounts = {
      fire: {},
      accident: {},
      flood: {},
      all: {}
    };
    const locationPins = {};

    const alertsRef = collection(firestore, 'Alerts');
    const alertsSnapshot = await getDocs(query(alertsRef));
    alertsSnapshot.forEach((doc) => {
      const data = doc.data();
      const loc = normalizeLocation(data.location);
      if (!loc) return;

      const type = (data.type || '').toLowerCase();
      locationCounts.all[loc] = (locationCounts.all[loc] || 0) + 1;
      recordLocationPin(locationPins, loc, data);

      if (type.includes('fire')) {
        locationCounts.fire[loc] = (locationCounts.fire[loc] || 0) + 1;
      } else if (type.includes('accident') || type.includes('vehicular') || type.includes('collision')) {
        locationCounts.accident[loc] = (locationCounts.accident[loc] || 0) + 1;
      } else if (type.includes('flood') || type.includes('typhoon') || type.includes('storm')) {
        locationCounts.flood[loc] = (locationCounts.flood[loc] || 0) + 1;
      }
    });

    const reportsRef = collection(firestore, 'Reports');
    const reportsSnapshot = await getDocs(query(reportsRef));
    reportsSnapshot.forEach((doc) => {
      const data = doc.data();
      const loc = normalizeLocation(data.location);
      if (!loc) return;

      const type = (data.type || '').toLowerCase();
      locationCounts.all[loc] = (locationCounts.all[loc] || 0) + 1;
      recordLocationPin(locationPins, loc, data);

      if (type.includes('fire')) {
        locationCounts.fire[loc] = (locationCounts.fire[loc] || 0) + 1;
      } else if (type.includes('accident') || type.includes('vehicular') || type.includes('collision')) {
        locationCounts.accident[loc] = (locationCounts.accident[loc] || 0) + 1;
      } else if (type.includes('flood') || type.includes('typhoon') || type.includes('storm')) {
        locationCounts.flood[loc] = (locationCounts.flood[loc] || 0) + 1;
      }
    });

    const sosRef = collection(firestore, 'SOS');
    const sosSnapshot = await getDocs(query(sosRef));
    sosSnapshot.forEach((doc) => {
      const data = doc.data();
      const loc = normalizeLocation(data.location);
      if (!loc) return;
      locationCounts.all[loc] = (locationCounts.all[loc] || 0) + 1;
      recordLocationPin(locationPins, loc, data);
    });

    renderHighRiskSection(locationCounts, locationPins);
  } catch (error) {
    console.error('Error loading high-risk analytics:', error);
  }
}

function normalizeLocation(location) {
  if (!location || typeof location !== 'string') return null;
  return location
    .replace(/\d+\.\d+,\s*\d+\.\d+/g, '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(',')[0]
    .trim();
}

function getTopLocations(locationMap, count = 5) {
  return Object.entries(locationMap)
    .filter(([loc]) => loc && loc.length > 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);
}

function renderHighRiskSection(locationCounts, locationPins = {}) {
  const container =
    document.getElementById('high-risk-analytics-root') ||
    document.querySelector('.analytics-container') ||
    document.querySelector('.recent-activity')?.parentElement;
  if (!container) return;

  const existingSection = document.getElementById('high-risk-analytics');
  if (existingSection) existingSection.remove();

  const topFires = getTopLocations(locationCounts.fire);
  const topAccidents = getTopLocations(locationCounts.accident);
  const topFloods = getTopLocations(locationCounts.flood);
  const topOverall = getTopLocations(locationCounts.all);

  const section = document.createElement('div');
  section.id = 'high-risk-analytics';
  section.className = 'card';
  section.style.cssText = 'margin-top: 20px; padding: 20px; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);';
  section.innerHTML = `
    <h3 style="margin: 0 0 20px 0; color: #1f2937; display: flex; align-items: center; gap: 8px;">
      <i class="fas fa-chart-bar" style="color: #ef4444;"></i>
      High-Risk Area Analytics
    </h3>
    <div class="high-risk-analytics-grid">
      ${renderRiskCard('Most Fires', topFires, '#ef4444', 'fa-fire', locationPins)}
      ${renderRiskCard('Most Accidents', topAccidents, '#f59e0b', 'fa-car-crash', locationPins)}
      ${renderRiskCard('Most Floods', topFloods, '#3b82f6', 'fa-water', locationPins)}
      ${renderRiskCard('Overall High-Risk', topOverall, '#8b5cf6', 'fa-exclamation-triangle', locationPins)}
    </div>
  `;

  container.appendChild(section);
}

function renderRiskCard(title, locations, color, icon, locationPins = {}) {
  const items = locations.length > 0
    ? locations.map(([loc, count], i) => {
        const encodedLoc = encodeURIComponent(loc);
        const pin = locationPins[loc];
        const href =
          pin != null && typeof pin.lat === 'number' && typeof pin.lng === 'number'
            ? `map.html?location=${encodedLoc}&lat=${encodeURIComponent(String(pin.lat))}&lng=${encodeURIComponent(String(pin.lng))}&analytics=1`
            : `map.html?location=${encodedLoc}&analytics=1`;
        return `
        <a href="${href}" 
           style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: ${i === 0 ? color + '15' : '#f9fafb'}; border-radius: 6px; margin-bottom: 4px; text-decoration: none; cursor: pointer; transition: transform 0.1s, box-shadow 0.1s;"
           onmouseover="this.style.transform='translateX(4px)';this.style.boxShadow='0 2px 8px rgba(0,0,0,0.1)'"
           onmouseout="this.style.transform='none';this.style.boxShadow='none'">
          <span style="font-size: 13px; color: #374151; font-weight: ${i === 0 ? '600' : '400'};">
            ${i + 1}. ${loc.length > 35 ? loc.substring(0, 35) + '...' : loc}
          </span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="background: ${color}; color: white; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600;">
              ${count}
            </span>
            <i class="fas fa-map-marker-alt" style="color:${color};font-size:11px;"></i>
          </div>
        </a>`;
      }).join('')
    : '<p style="text-align: center; color: #9ca3af; font-size: 13px; padding: 15px 0;">No data available</p>';

  return `
    <div style="border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden;">
      <div style="background: ${color}; padding: 12px 16px; display: flex; align-items: center; gap: 8px;">
        <i class="fas ${icon}" style="color: white;"></i>
        <span style="color: white; font-weight: 600; font-size: 14px;">${title}</span>
      </div>
      <div style="padding: 12px;">
        ${items}
      </div>
    </div>
  `;
}
