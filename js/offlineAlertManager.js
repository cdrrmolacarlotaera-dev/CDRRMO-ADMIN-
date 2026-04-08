/**
 * offlineAlertManager.js
 * 
 * Admin panel component to manage offline/SMS-based SOS alerts
 * 
 * Features:
 * - Display ALL SOS alerts (both online and offline)
 * - Highlight alerts that were sent offline and synced later
 * - Show SMS gateway integration status
 * - Manual entry for SMS-received alerts
 * - Analytics for offline alert patterns
 */

import { 
  firestore, 
  collection, 
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  onSnapshot,
  limit,
  getDoc
} from './firebase-api.js';
import smsService from './smsService.js';
import adminLogger from './admin-logger.js';
import { getPhonesForTeamDispatch } from './team-dispatch-phones.js';
import {
  releaseAssignedTeamAfterResolve,
  releasePreviousTeamOnReassign,
} from './release-team-on-resolve.js';

class OfflineAlertManager {
  constructor() {
    this.offlineAlerts = [];
    this.allSOSAlerts = [];
    this.unsubscribe = null;
    this.allSOSUnsubscribe = null;
    // Pages where the Active SOS Alert UI section should appear
    // Keep it only on the Reports page (report.html)
    this.pagesWithUI = ['report.html'];
  }

  /**
   * Check if current page should show the SOS UI section
   */
  shouldShowUISection() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    return this.pagesWithUI.some(page => currentPage.includes(page));
  }

  /**
   * Initialize the offline alert manager
   */
  async initialize() {
    console.log('[OfflineAlertManager] Initializing...');
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    console.log('[OfflineAlertManager] Current page:', currentPage);
    
    await this.loadAllSOSAlerts();
    await this.loadOfflineAlerts();
    this.setupRealtimeListener();
    this.setupAllSOSListener();
    
    // Only render UI section on dashboard and report pages
    if (this.shouldShowUISection()) {
      console.log('[OfflineAlertManager] Rendering UI section on this page');
      this.renderOfflineAlertsSection();
    } else {
      console.log('[OfflineAlertManager] Notifications only mode (no UI section)');
    }
  }

  /**
   * Load ALL SOS alerts (both online and offline)
   */
  async loadAllSOSAlerts() {
    try {
      const sosRef = collection(firestore, 'SOS');
      const q = query(
        sosRef,
        where('status', 'in', ['pending', 'dispatched', 'ongoing']),
        orderBy('timestamp', 'desc'),
        limit(50)
      );

      const snapshot = await getDocs(q);
      this.allSOSAlerts = snapshot.docs.map(docSnap => {
        const data = docSnap.data();
        return {
          ...data,
          id: docSnap.id,  // Firebase document ID (not local SOS ID)
          localId: data.id || null  // Keep local ID separately if exists
        };
      });

      console.log(`[OfflineAlertManager] Loaded ${this.allSOSAlerts.length} total SOS alerts`);
    } catch (error) {
      console.error('[OfflineAlertManager] Error loading all SOS:', error);
    }
  }

  /**
   * Load alerts that were created offline
   */
  async loadOfflineAlerts() {
    try {
      const sosRef = collection(firestore, 'SOS');
      // Query for both wasOffline and isOffline fields
      const q = query(
        sosRef,
        orderBy('timestamp', 'desc'),
        limit(100)
      );

      const snapshot = await getDocs(q);
      // Filter for offline alerts (check both field names)
      this.offlineAlerts = snapshot.docs
        .map(docSnap => {
          const data = docSnap.data();
          return {
            ...data,
            id: docSnap.id,  // Firebase document ID
            localId: data.id || null
          };
        })
        .filter(alert => alert.wasOffline === true || alert.isOffline === true);

      console.log(`[OfflineAlertManager] Loaded ${this.offlineAlerts.length} offline alerts`);
    } catch (error) {
      console.error('[OfflineAlertManager] Error loading alerts:', error);
    }
  }

  /**
   * Setup real-time listener for ALL active SOS alerts
   */
  setupAllSOSListener() {
    try {
      const sosRef = collection(firestore, 'SOS');
      const q = query(
        sosRef,
        where('status', 'in', ['pending', 'dispatched', 'ongoing']),
        orderBy('timestamp', 'desc'),
        limit(50)
      );

      this.allSOSUnsubscribe = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const data = change.doc.data();
            const alert = {
              ...data,
              id: change.doc.id,  // Firebase document ID
              localId: data.id || null
            };

            // Show notification for new SOS
            const timestamp = alert.timestamp?.toDate ? alert.timestamp.toDate() : new Date(alert.timestamp);
            const now = new Date();
            const diffMinutes = (now - timestamp) / (1000 * 60);

            if (diffMinutes < 2) {
              this.showNewSOSNotification(alert);
            }
          }
        });

        // Update the list
        this.allSOSAlerts = snapshot.docs.map(docSnap => {
          const data = docSnap.data();
          return {
            ...data,
            id: docSnap.id,  // Firebase document ID
            localId: data.id || null
          };
        });

        this.updateOfflineAlertsUI();
      });
    } catch (error) {
      console.error('[OfflineAlertManager] All SOS Listener error:', error);
    }
  }

  /**
   * Setup real-time listener for new offline alerts
   */
  setupRealtimeListener() {
    try {
      const sosRef = collection(firestore, 'SOS');
      const q = query(
        sosRef,
        orderBy('timestamp', 'desc'),
        limit(100)
      );

      this.unsubscribe = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'added') {
            const data = change.doc.data();
            const alert = {
              ...data,
              id: change.doc.id,  // Firebase document ID
              localId: data.id || null
            };

            // Check if this is an offline alert
            if (alert.wasOffline || alert.isOffline) {
              // Check if we need to show notification
              const syncedAt = alert.syncedAt;
              if (syncedAt) {
                const syncTime = new Date(syncedAt);
                const now = new Date();
                const diffMinutes = (now - syncTime) / (1000 * 60);

                if (diffMinutes < 5) {
                  this.showOfflineAlertNotification(alert);
                }
              }
            }
          }
        });

        // Update offline alerts list
        this.offlineAlerts = snapshot.docs
          .map(docSnap => {
            const data = docSnap.data();
            return {
              ...data,
              id: docSnap.id,  // Firebase document ID
              localId: data.id || null
            };
          })
          .filter(alert => alert.wasOffline === true || alert.isOffline === true);

        this.updateOfflineAlertsUI();
      });
    } catch (error) {
      console.error('[OfflineAlertManager] Listener error:', error);
    }
  }

  /**
   * Show notification for new SOS alert
   */
  showNewSOSNotification(alert) {
    const isOffline = alert.wasOffline || alert.isOffline;
    const notification = document.createElement('div');
    notification.className = 'offline-alert-notification sos-notification';
    notification.innerHTML = `
      <div class="notification-icon">🚨</div>
      <div class="notification-content">
        <h4>NEW SOS ALERT${isOffline ? ' (Offline Synced)' : ''}</h4>
        <p><strong>${alert.reportedBy || 'Unknown'}</strong> needs help!</p>
        <p>📍 ${alert.location || 'Unknown location'}</p>
        ${alert.contactNumber ? `<p>📞 ${alert.contactNumber}</p>` : ''}
      </div>
      <button class="notification-close" onclick="this.parentElement.remove()">×</button>
    `;

    document.body.appendChild(notification);

    // Play alert sound
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1');
      audio.play().catch(() => {});
    } catch(e) {}

    // Auto-remove after 15 seconds
    setTimeout(() => {
      notification.remove();
    }, 15000);
  }

  /**
   * Show notification for synced offline alert
   */
  showOfflineAlertNotification(alert) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'offline-alert-notification';
    notification.innerHTML = `
      <div class="notification-icon">📱</div>
      <div class="notification-content">
        <h4>Offline SOS Synced</h4>
        <p>An SOS from ${alert.reportedBy || 'Unknown'} was sent while offline and has now been synced.</p>
        <small>Original time: ${new Date(alert.offlineCreatedAt).toLocaleString()}</small>
      </div>
      <button class="notification-close" onclick="this.parentElement.remove()">×</button>
    `;

    document.body.appendChild(notification);

    // Auto-remove after 10 seconds
    setTimeout(() => {
      notification.remove();
    }, 10000);
  }

  /**
   * Render the offline alerts section in admin panel
   * Only on dashboard and report pages
   */
  renderOfflineAlertsSection() {
    // Only render on allowed pages
    if (!this.shouldShowUISection()) {
      return;
    }
    
    const container = document.getElementById('offline-alerts-container');
    if (!container) {
      console.log('[OfflineAlertManager] Container not found, creating...');
      this.createOfflineAlertsContainer();
    }
  }

  /**
   * Create the offline alerts container if it doesn't exist
   * Only on dashboard and report pages
   */
  createOfflineAlertsContainer() {
    // Only create on allowed pages
    if (!this.shouldShowUISection()) {
      return;
    }
    
    // Find the main content area
    const mainContent = document.querySelector('.main-content') || document.querySelector('main');
    if (!mainContent) return;

    const section = document.createElement('div');
    section.id = 'offline-alerts-section';
    section.className = 'offline-alerts-section';
    section.style.cssText = 'background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px; overflow: hidden;';
    section.innerHTML = `
      <div style="background: linear-gradient(135deg, #ef4444, #dc2626); padding: 12px 16px; display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin: 0; color: white; font-size: 16px; display: flex; align-items: center; gap: 8px;">
          🚨 Active SOS Alerts
          <span style="background: white; color: #ef4444; padding: 2px 8px; border-radius: 10px; font-size: 12px;" id="total-sos-count">0</span>
        </h3>
        <div style="display: flex; gap: 8px;">
          <button id="refresh-offline-alerts" class="btn btn-sm" style="background: rgba(255,255,255,0.2); color: white; padding: 5px 10px; font-size: 12px;">
            🔄 Refresh
          </button>
          <button id="add-sms-alert" class="btn btn-sm" style="background: white; color: #ef4444; padding: 5px 10px; font-size: 12px;">
            ➕ Add SMS
          </button>
        </div>
      </div>
      <div id="offline-alerts-container" style="padding: 12px; max-height: 350px; overflow-y: auto;">
        <div class="loading" style="text-align: center; padding: 20px; color: #6b7280;">Loading...</div>
      </div>
    `;

    // Insert at the beginning of main content
    mainContent.insertBefore(section, mainContent.firstChild);

    // Add event listeners
    document.getElementById('refresh-offline-alerts')?.addEventListener('click', () => {
      this.loadOfflineAlerts();
    });

    document.getElementById('add-sms-alert')?.addEventListener('click', () => {
      this.showAddSMSAlertModal();
    });

    this.updateOfflineAlertsUI();
  }

  /**
   * Update the offline alerts UI - Shows ALL SOS alerts
   */
  updateOfflineAlertsUI() {
    const container = document.getElementById('offline-alerts-container');
    if (!container) return;

    // Show ALL active SOS alerts (deduplicated by reportedBy + timestamp to avoid duplicates)
    const activeAlerts = this.allSOSAlerts.filter(a => a.status === 'active');
    
    // Deduplicate based on key properties (same person, same time = likely duplicate)
    const seen = new Set();
    const uniqueAlerts = activeAlerts.filter(alert => {
      const key = `${alert.reportedBy || ''}_${alert.contactNumber || ''}_${alert.location || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    // Update stats
    const totalCount = document.getElementById('total-sos-count');
    if (totalCount) totalCount.textContent = uniqueAlerts.length;

    if (uniqueAlerts.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 30px; color: #6b7280;">
          <span style="font-size: 32px;">✅</span>
          <p style="margin: 10px 0 0 0; font-weight: 500;">No active SOS alerts</p>
        </div>
      `;
      return;
    }

    // Create compact list view
    container.innerHTML = uniqueAlerts.map(alert => {
      const isOffline = alert.wasOffline || alert.isOffline || alert.sosSource === 'offline';
      const citizenName = alert.reportedByName || alert.reportedBy || 'Anonymous';
      const citizenPhone = alert.reportedByContactNumber || alert.contactNumber || '';
      const isAssigned = alert.assignedTeamId;
      
      return `
      <div class="offline-alert-card active" style="border-left: 4px solid ${isOffline ? '#f97316' : '#ef4444'}; padding: 12px; margin-bottom: 10px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="display: flex; gap: 6px; align-items: center;">
            <span style="padding: 3px 8px; background: ${isOffline ? '#f97316' : '#ef4444'}; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">
              ${isOffline ? '📱 OFFLINE' : '🚨 SOS'}
            </span>
            ${isAssigned ? `<span style="padding: 3px 8px; background: #22c55e; color: white; border-radius: 4px; font-size: 11px;">✓ Sent</span>` : ''}
          </div>
          <span style="font-size: 11px; color: #6b7280;">${this.formatTime(alert.timestamp)}</span>
        </div>
        
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #1f2937; font-size: 14px;">
              ${citizenName}
              ${citizenPhone ? `<a href="tel:${citizenPhone}" style="color: #3b82f6; font-size: 12px; margin-left: 8px;">📞 ${citizenPhone}</a>` : ''}
            </div>
            <div style="font-size: 12px; color: #6b7280; margin-top: 2px;">📍 ${alert.location || 'Unknown'}</div>
          </div>
          
          <div style="display: flex; gap: 6px;">
            ${!isAssigned ? `
              <button type="button" style="background: #8b5cf6; color: white; padding: 6px 12px; font-size: 12px; border: none; cursor: pointer; border-radius: 6px;" 
                      data-alert-id="${alert.id}"
                      onclick="console.log('Button clicked!'); window.offlineAlertManager.openSendToResponderModal(this.dataset.alertId)">
                📤 Send
              </button>
            ` : ''}
            ${alert.coordinates ? `
              <button type="button" style="background: #3b82f6; color: white; padding: 6px 10px; font-size: 12px; border: none; cursor: pointer; border-radius: 6px;" 
                      onclick="window.offlineAlertManager.getDirections(${alert.coordinates.latitude}, ${alert.coordinates.longitude})">
                🧭
              </button>
            ` : ''}
            <button type="button" style="background: #22c55e; color: white; padding: 6px 10px; font-size: 12px; border: none; cursor: pointer; border-radius: 6px;" 
                    data-alert-id="${alert.id}"
                    onclick="window.offlineAlertManager.resolveAlert(this.dataset.alertId)">
              ✓
            </button>
          </div>
        </div>
      </div>
    `}).join('');
  }

  /**
   * Get directions to location
   */
  getDirections(lat, lng) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
  }

  /**
   * Format timestamp for display
   */
  formatTime(timestamp) {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString();
  }

  /**
   * Open map for coordinates
   */
  openMap(lat, lng) {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
  }

  /**
   * Resolve an SOS alert
   */
  async resolveAlert(alertId) {
    // Confirm before resolving
    if (!confirm('Are you sure you want to resolve this SOS alert?')) {
      return;
    }

    try {
      console.log(`[OfflineAlertManager] Resolving alert with Firebase ID: ${alertId}`);
      
      const alertRef = doc(firestore, 'SOS', alertId);
      const beforeSnap = await getDoc(alertRef);
      const beforeData = beforeSnap.exists() ? beforeSnap.data() : {};

      await updateDoc(alertRef, {
        status: 'resolved',
        isResolved: true,
        resolvedAt: serverTimestamp(),
        resolvedBy: 'admin'
      });

      await releaseAssignedTeamAfterResolve(alertId, beforeData, 'offline_alert_manager');

      console.log(`[OfflineAlertManager] Alert ${alertId} resolved successfully`);
      
      // Show success message
      this.showSuccessNotification('SOS Alert Resolved', 'The emergency has been marked as resolved.');
      
      // Log admin action
      adminLogger.log('resolve_sos', 'Incident', alertId, {
        source: 'offline_manager'
      });
      
      // Refresh the list
      await this.loadAllSOSAlerts();
      this.updateOfflineAlertsUI();
      
    } catch (error) {
      console.error('[OfflineAlertManager] Error resolving alert:', error);
      alert(`Error resolving alert: ${error.message}\n\nPlease try refreshing the page.`);
    }
  }

  /**
   * Show success notification
   */
  showSuccessNotification(title, message) {
    const notification = document.createElement('div');
    notification.className = 'offline-alert-notification';
    notification.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    notification.innerHTML = `
      <div class="notification-icon">✅</div>
      <div class="notification-content">
        <h4>${title}</h4>
        <p>${message}</p>
      </div>
      <button class="notification-close" onclick="this.parentElement.remove()">×</button>
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 5000);
  }

  /**
   * Show modal to manually add SMS-received alert
   * @param {Object|null} prefillData - Optional data to pre-fill the form (from offline SOS)
   */
  showAddSMSAlertModal(prefillData = null) {
    // Remove existing modal if any
    document.getElementById('sms-alert-modal')?.remove();
    
    const isPrefilled = prefillData !== null;
    const modalTitle = isPrefilled ? '📱 Offline SOS Details' : '📱 Add SMS Alert';
    const modalInfo = isPrefilled 
      ? `This SOS was sent offline by the citizen. Review and update the information if needed.`
      : 'Enter details from an SMS emergency message received on the CDRRMO hotline.';
    
    // Extract data from prefillData or use empty values
    const name = prefillData?.reportedByName || prefillData?.reportedBy || '';
    const phone = prefillData?.reportedByContactNumber || prefillData?.contactNumber || '';
    const content = prefillData?.details || '';
    const location = prefillData?.location || '';
    const lat = prefillData?.coordinates?.latitude || '';
    const lng = prefillData?.coordinates?.longitude || '';
    const timestamp = prefillData?.timestamp ? this.formatTime(prefillData.timestamp) : '';
    const offlineTime = prefillData?.offlineCreatedAt || prefillData?.offlineQueuedAt || '';
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'sms-alert-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header" style="${isPrefilled ? 'background: linear-gradient(135deg, #f97316, #ea580c);' : ''}">
          <h3>${modalTitle}</h3>
          <button class="close-btn" onclick="document.getElementById('sms-alert-modal').remove()">×</button>
        </div>
        <div class="modal-body">
          <p class="modal-info">${modalInfo}</p>
          
          ${isPrefilled ? `
          <div style="background: #fff7ed; border: 1px solid #f97316; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <span style="font-size: 20px;">📱</span>
              <strong style="color: #c2410c;">Offline SOS Information</strong>
            </div>
            <p style="margin: 0; font-size: 0.9rem; color: #7c2d12;">
              ${offlineTime ? `Sent offline at: <strong>${new Date(offlineTime).toLocaleString()}</strong>` : ''}
              ${timestamp ? `<br>Synced at: <strong>${timestamp}</strong>` : ''}
            </p>
          </div>
          ` : ''}
          
          <div class="form-group">
            <label>Sender Name</label>
            <input type="text" id="sms-sender-name" placeholder="Name of person who sent SOS" value="${name}">
          </div>
          
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" id="sms-phone" placeholder="+639XXXXXXXXX" value="${phone}">
            ${phone ? `<a href="tel:${phone}" style="display: inline-block; margin-top: 5px; color: #2563eb; text-decoration: underline;">📞 Call Now</a>` : ''}
          </div>
          
          <div class="form-group">
            <label>SMS Content / Details</label>
            <textarea id="sms-content" rows="4" placeholder="Paste the SMS content here...">${content}</textarea>
          </div>
          
          <div class="form-group">
            <label>Location (if known)</label>
            <input type="text" id="sms-location" placeholder="Address or coordinates" value="${location}">
          </div>
          
          <div class="form-row">
            <div class="form-group half">
              <label>Latitude</label>
              <input type="number" id="sms-lat" step="any" placeholder="e.g., 10.4273" value="${lat}">
            </div>
            <div class="form-group half">
              <label>Longitude</label>
              <input type="number" id="sms-lng" step="any" placeholder="e.g., 122.9203" value="${lng}">
            </div>
          </div>
          
          ${lat && lng ? `
          <div style="margin-top: 10px;">
            <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" 
               style="display: inline-block; padding: 8px 16px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none;">
              🗺️ View on Google Maps
            </a>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving" target="_blank"
               style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; border-radius: 6px; text-decoration: none; margin-left: 8px;">
              🧭 Get Directions
            </a>
          </div>
          ` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('sms-alert-modal').remove()">Cancel</button>
          ${isPrefilled ? `
            <button class="btn" style="background: #f97316; color: white;" onclick="offlineAlertManager.updateOfflineAlert('${prefillData?.id}')">
              <span>💾</span> Update Alert
            </button>
          ` : `
            <button class="btn btn-primary" onclick="offlineAlertManager.saveSMSAlert()">Add Alert</button>
          `}
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }
  
  /**
   * Open SMS modal pre-filled with offline SOS data
   * @param {string} alertId - The ID of the offline SOS alert
   */
  openOfflineSOSModal(alertId) {
    const alert = this.allSOSAlerts.find(a => a.id === alertId);
    if (alert) {
      this.showAddSMSAlertModal(alert);
    } else {
      console.error('[OfflineAlertManager] Alert not found:', alertId);
    }
  }

  /**
   * Open "Send to Responder" modal with citizen credentials pre-filled
   * @param {string} alertId - The ID of the SOS alert
   */
  async openSendToResponderModal(alertId) {
    try {
      console.log('[OfflineAlertManager] ========================================');
      console.log('[OfflineAlertManager] Opening Send to Responder modal');
      console.log('[OfflineAlertManager] Alert ID:', alertId);
      console.log('[OfflineAlertManager] Total alerts in memory:', this.allSOSAlerts.length);
      
      const alert = this.allSOSAlerts.find(a => a.id === alertId);
      if (!alert) {
        console.error('[OfflineAlertManager] Alert not found! Available IDs:', this.allSOSAlerts.map(a => a.id));
        window.alert('Error: SOS alert not found. Please click Refresh and try again.');
        return;
      }
      
      console.log('[OfflineAlertManager] Alert found:', alert.reportedBy, alert.location);

      // Load available teams
      let availableTeams = [];
      try {
        console.log('[OfflineAlertManager] Loading available teams...');
        const teamsRef = collection(firestore, 'Teams');
        const teamsQuery = query(teamsRef, where('status', '==', 'available'));
        const snapshot = await getDocs(teamsQuery);
        availableTeams = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log('[OfflineAlertManager] Teams loaded:', availableTeams.length, availableTeams.map(t => t.name));
      } catch (error) {
        console.error('[OfflineAlertManager] Error loading teams:', error);
        // Continue anyway - we can still show modal without teams
      }

    // Get citizen info
    const citizenName = alert.reportedByName || alert.reportedBy || 'Unknown';
    const citizenPhone = alert.reportedByContactNumber || alert.contactNumber || '';
    const location = alert.location || 'Unknown location';
    const lat = alert.coordinates?.latitude || '';
    const lng = alert.coordinates?.longitude || '';
    const details = alert.details || 'Emergency assistance requested';
    const isOffline = alert.wasOffline || alert.isOffline || alert.sosSource === 'offline';

    // Remove existing modal
    document.getElementById('send-responder-modal')?.remove();

    // Create modal with inline styles (no external CSS needed)
    const modal = document.createElement('div');
    modal.id = 'send-responder-modal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000;';
    modal.innerHTML = `
      <div style="background: white; border-radius: 16px; max-width: 600px; width: 90%; max-height: 90vh; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
        <div style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); padding: 16px 20px; display: flex; justify-content: space-between; align-items: center;">
          <h3 style="margin: 0; color: white; font-size: 18px;">📤 Send SOS to Responder Team</h3>
          <button onclick="document.getElementById('send-responder-modal').remove()" style="background: rgba(255,255,255,0.2); border: none; color: white; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-size: 18px;">×</button>
        </div>
        <div style="max-height: 60vh; overflow-y: auto; padding: 20px;">
          
          <!-- SOS Type Badge -->
          <div style="text-align: center; margin-bottom: 20px;">
            <span style="display: inline-block; padding: 8px 20px; background: ${isOffline ? '#f97316' : '#ef4444'}; color: white; border-radius: 20px; font-weight: bold;">
              ${isOffline ? '📱 OFFLINE SOS' : '🚨 SOS EMERGENCY'}
            </span>
          </div>
          
          <!-- Citizen Credentials Card (Auto-filled) -->
          <div style="background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 2px solid #22c55e; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
            <h4 style="margin: 0 0 15px 0; color: #166534; display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 24px;">👤</span> Citizen Information
            </h4>
            
            <div style="display: grid; gap: 12px;">
              <div style="display: flex; align-items: center; gap: 12px; padding: 10px; background: white; border-radius: 8px;">
                <span style="font-size: 20px;">👤</span>
                <div style="flex: 1;">
                  <div style="font-size: 12px; color: #6b7280;">Full Name</div>
                  <div style="font-size: 16px; font-weight: 600; color: #1f2937;">${citizenName}</div>
                </div>
              </div>
              
              <div style="display: flex; align-items: center; gap: 12px; padding: 10px; background: white; border-radius: 8px;">
                <span style="font-size: 20px;">📞</span>
                <div style="flex: 1;">
                  <div style="font-size: 12px; color: #6b7280;">Phone Number</div>
                  <div style="font-size: 16px; font-weight: 600; color: #3b82f6;">${citizenPhone || 'Not provided'}</div>
                </div>
                ${citizenPhone ? `<a href="tel:${citizenPhone}" style="padding: 6px 12px; background: #22c55e; color: white; border-radius: 6px; text-decoration: none; font-size: 14px;">📞 Call</a>` : ''}
              </div>
              
              <div style="display: flex; align-items: center; gap: 12px; padding: 10px; background: white; border-radius: 8px;">
                <span style="font-size: 20px;">📍</span>
                <div style="flex: 1;">
                  <div style="font-size: 12px; color: #6b7280;">Location</div>
                  <div style="font-size: 14px; font-weight: 500; color: #1f2937;">${location}</div>
                  ${lat && lng ? `<div style="font-size: 12px; color: #6b7280; margin-top: 4px;">GPS: ${lat}, ${lng}</div>` : ''}
                </div>
                ${lat && lng ? `<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="padding: 6px 12px; background: #3b82f6; color: white; border-radius: 6px; text-decoration: none; font-size: 14px;">🗺️ Map</a>` : ''}
              </div>
              
              <div style="padding: 10px; background: white; border-radius: 8px;">
                <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">📝 Details</div>
                <div style="font-size: 14px; color: #374151;">${details}</div>
              </div>
            </div>
          </div>
          
          <!-- Select Responder Team -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px;">
            <h4 style="margin: 0 0 15px 0; color: #1e293b; display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 24px;">👥</span> Select Responder Team
            </h4>
            
            <select id="responder-team-select" style="width: 100%; padding: 12px; border: 2px solid #8b5cf6; border-radius: 8px; font-size: 16px; background: white;">
              <option value="">-- Choose a Team --</option>
              ${availableTeams.length > 0 ? 
                availableTeams.map(team => `
                  <option value="${team.id}" data-name="${team.name}" data-type="${team.type || 'general'}">
                    ${team.name} (${team.type || 'General'}) - ${team.members || 0} members
                  </option>
                `).join('') :
                '<option value="" disabled>No available teams</option>'
              }
            </select>
            
            ${availableTeams.length === 0 ? `
              <p style="color: #ef4444; margin-top: 10px; font-size: 14px;">
                ⚠️ No teams are currently available. Please check Team Management.
              </p>
            ` : ''}
          </div>
          
          <!-- SMS Notification Option -->
          <div style="background: #dcfce7; border: 1px solid #22c55e; border-radius: 12px; padding: 15px; margin-top: 15px;">
            <h5 style="margin: 0 0 8px 0; color: #166534; display: flex; align-items: center; gap: 8px;">
              <span>📱</span> SMS Notification
              <span style="background: #22c55e; color: white; padding: 2px 8px; border-radius: 10px; font-size: 11px;">ACTIVE</span>
            </h5>
            <p style="margin: 0; font-size: 13px; color: #166534;">
              Responders will receive an SMS with citizen credentials and location.
            </p>
            <label style="display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer;">
              <input type="checkbox" id="send-sms-checkbox" checked style="width: 18px; height: 18px; accent-color: #22c55e;">
              <span style="font-size: 14px; color: #166534; font-weight: 500;">Send SMS to responder team members</span>
            </label>
          </div>
          
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; padding: 15px 20px; border-top: 1px solid #e5e7eb; background: #f9fafb;">
          <button onclick="document.getElementById('send-responder-modal').remove()" style="padding: 10px 20px; background: #e5e7eb; color: #374151; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500;">
            Cancel
          </button>
          <button onclick="offlineAlertManager.sendToResponder('${alertId}')" style="padding: 10px 24px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: bold;">
            📤 Send to Responder
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    console.log('[OfflineAlertManager] Modal created and appended to body');
    console.log('[OfflineAlertManager] ========================================');
    
    } catch (error) {
      console.error('[OfflineAlertManager] ERROR in openSendToResponderModal:', error);
      window.alert('Error opening modal: ' + error.message);
    }
  }

  /**
   * Send SOS to selected responder team
   * @param {string} alertId - The ID of the SOS alert
   */
  async sendToResponder(alertId) {
    const teamSelect = document.getElementById('responder-team-select');
    const teamId = teamSelect?.value;
    const sendSMS = document.getElementById('send-sms-checkbox')?.checked;

    if (!teamId) {
      alert('Please select a responder team.');
      return;
    }

    const selectedOption = teamSelect.options[teamSelect.selectedIndex];
    const teamName = selectedOption.dataset.name;
    const teamType = selectedOption.dataset.type;

    try {
      // Get the SOS alert data
      const sosAlert = this.allSOSAlerts.find(a => a.id === alertId);
      
      const sosRef = doc(firestore, 'SOS', alertId);
      const priorSnap = await getDoc(sosRef);
      const prior = priorSnap.exists() ? priorSnap.data() : {};
      const prevTeamId = prior.assignedTeamId || prior.assignedTeam;
      if (prevTeamId && prevTeamId !== teamId) {
        await releasePreviousTeamOnReassign(prevTeamId, alertId, 'offline_sos_dispatch');
      }

      // Update the SOS with team assignment
      await updateDoc(sosRef, {
        assignedTeamId: teamId,
        assignedTeamName: teamName,
        assignedTeamType: teamType,
        assignedAt: serverTimestamp(),
        assignedBy: 'admin',
        smsSent: sendSMS
      });

      // Update team status
      const teamRef = doc(firestore, 'Teams', teamId);
      const lat = sosAlert?.coordinates?.latitude || 0;
      const lng = sosAlert?.coordinates?.longitude || 0;

      await updateDoc(teamRef, {
        status: 'on-mission',
        currentMission: alertId,
        missionType: 'sos',
        missionLocation: sosAlert?.location || 'Unknown',
        missionCoordinates: { latitude: lat, longitude: lng },
        missionStartedAt: serverTimestamp()
      });

      // Send SMS to team members if enabled
      let smsResult = { success: 0, failed: 0 };
      if (sendSMS) {
        try {
          const responderPhones = await getPhonesForTeamDispatch(teamId, teamName);
          console.log('[OfflineAlertManager] Sending SMS to:', responderPhones);
          if (responderPhones.length > 0) {
            smsResult = await smsService.sendToMultipleResponders(
              sosAlert,
              { name: teamName, type: teamType },
              responderPhones
            );
          }
        } catch (smsError) {
          console.error('[OfflineAlertManager] SMS Error:', smsError);
        }
      }

      // Close modal
      document.getElementById('send-responder-modal')?.remove();
      
      // Show success notification
      let message = `Team "${teamName}" has been dispatched!`;
      if (sendSMS && smsResult.success > 0) {
        message += `\n📱 SMS sent to ${smsResult.success} responder(s).`;
      }
      if (sendSMS && smsResult.failed > 0) {
        message += `\n⚠️ ${smsResult.failed} SMS failed to send.`;
      }
      
      this.showSuccessNotification('✅ SOS Sent to Responder!', message);

      // Refresh the list
      await this.loadAllSOSAlerts();
      this.updateOfflineAlertsUI();

    } catch (error) {
      console.error('[OfflineAlertManager] Error sending to responder:', error);
      alert('Error sending to responder: ' + error.message);
    }
  }
  
  /**
   * Update an existing offline alert with new information
   * @param {string} alertId - The ID of the alert to update
   */
  async updateOfflineAlert(alertId) {
    try {
      const name = document.getElementById('sms-sender-name')?.value || 'Unknown';
      const phone = document.getElementById('sms-phone')?.value || '';
      const content = document.getElementById('sms-content')?.value || '';
      const location = document.getElementById('sms-location')?.value || 'Unknown';
      const lat = parseFloat(document.getElementById('sms-lat')?.value);
      const lng = parseFloat(document.getElementById('sms-lng')?.value);

      const updateData = {
        reportedBy: name,
        reportedByName: name,
        contactNumber: phone,
        reportedByContactNumber: phone,
        details: content || 'SMS Emergency received on CDRRMO hotline',
        location: location,
        updatedAt: serverTimestamp(),
        updatedBy: 'admin'
      };

      // Add coordinates if provided
      if (!isNaN(lat) && !isNaN(lng)) {
        updateData.coordinates = {
          latitude: lat,
          longitude: lng
        };
      }

      const alertRef = doc(firestore, 'SOS', alertId);
      await updateDoc(alertRef, updateData);
      
      console.log('[OfflineAlertManager] Offline alert updated:', alertId);
      document.getElementById('sms-alert-modal')?.remove();
      
      this.showSuccessNotification('Alert Updated', 'The offline SOS information has been updated.');
      
      // Refresh the list
      await this.loadAllSOSAlerts();
      this.updateOfflineAlertsUI();
      
    } catch (error) {
      console.error('[OfflineAlertManager] Error updating alert:', error);
      alert('Error updating alert: ' + error.message);
    }
  }

  /**
   * Save manually entered SMS alert
   */
  async saveSMSAlert() {
    try {
      const name = document.getElementById('sms-sender-name')?.value || 'Unknown';
      const phone = document.getElementById('sms-phone')?.value || '';
      const content = document.getElementById('sms-content')?.value || '';
      const location = document.getElementById('sms-location')?.value || 'Unknown';
      const lat = parseFloat(document.getElementById('sms-lat')?.value);
      const lng = parseFloat(document.getElementById('sms-lng')?.value);

      const alertData = {
        type: 'SOS Emergency',
        location: location,
        details: content || 'SMS Emergency received on CDRRMO hotline',
        reportedBy: name,
        reportedByEmail: 'sms_alert',
        contactNumber: phone,
        status: 'active',
        isResolved: false,
        isAcknowledged: false,
        wasOffline: true,
        isManualSMSEntry: true,
        timestamp: serverTimestamp(),
        offlineCreatedAt: new Date().toISOString(),
        syncedAt: new Date().toISOString()
      };

      // Add coordinates if provided
      if (!isNaN(lat) && !isNaN(lng)) {
        alertData.coordinates = {
          latitude: lat,
          longitude: lng
        };
      }

      await addDoc(collection(firestore, 'SOS'), alertData);
      
      console.log('[OfflineAlertManager] SMS alert added');
      document.getElementById('sms-alert-modal')?.remove();
      alert('SMS alert added successfully');
      
    } catch (error) {
      console.error('[OfflineAlertManager] Error adding SMS alert:', error);
      alert('Error adding SMS alert');
    }
  }

  /**
   * Parse SMS content to extract information
   */
  parseSMSContent(smsText) {
    const result = {
      name: null,
      phone: null,
      coordinates: null,
      location: null,
      sosId: null
    };

    try {
      // Try to extract name
      const nameMatch = smsText.match(/From:\s*(.+?)(?:\n|$)/i);
      if (nameMatch) result.name = nameMatch[1].trim();

      // Try to extract phone
      const phoneMatch = smsText.match(/Tel:\s*(.+?)(?:\n|$)/i);
      if (phoneMatch) result.phone = phoneMatch[1].trim();

      // Try to extract coordinates
      const coordMatch = smsText.match(/Loc:\s*([-\d.]+)\s*,\s*([-\d.]+)/i);
      if (coordMatch) {
        result.coordinates = {
          latitude: parseFloat(coordMatch[1]),
          longitude: parseFloat(coordMatch[2])
        };
      }

      // Try to extract SOS ID
      const idMatch = smsText.match(/ID:\s*(SOS_[A-Za-z0-9_]+)/i);
      if (idMatch) result.sosId = idMatch[1];

    } catch (error) {
      console.error('[OfflineAlertManager] Error parsing SMS:', error);
    }

    return result;
  }

  /**
   * Cleanup listeners
   */
  cleanup() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }
}

// Create and export instance
const offlineAlertManager = new OfflineAlertManager();

// Make available globally for onclick handlers
window.offlineAlertManager = offlineAlertManager;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Only initialize on relevant pages
  if (document.querySelector('.main-content') || document.querySelector('main')) {
    offlineAlertManager.initialize();
  }
});

export default offlineAlertManager;
