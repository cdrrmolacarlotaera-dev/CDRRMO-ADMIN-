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
            orderBy,
            serverTimestamp 
        } from './firebase-api.js';
        import { initAdminRealtimeHub } from './admin-notifications.js';
        import { notifyUser } from './smsService.js';
        import { getPhonesForTeamDispatch } from './team-dispatch-phones.js';
        import { releasePreviousTeamOnReassign } from './release-team-on-resolve.js';
        initAdminRealtimeHub();

        // Store data globally
        let allEmergencies = [];
        let currentFilter = 'all';
        let currentEmergency = null;
        let availableTeams = [];

        // FIX: expose as window.exportReportData so the onclick="" attribute
        // on the button can find it. Functions defined inside <script type="module">
        // are module-scoped and NOT available on the global window object.
        window.exportReportData = function exportReportData() {
            const data = currentFilter === 'all'
                ? allEmergencies
                : allEmergencies.filter(e => {
                    if (currentFilter === 'alerts') return e.collection === 'Alerts';
                    if (currentFilter === 'reports') return e.collection === 'Reports';
                    if (currentFilter === 'sos') return e.collection === 'SOS';
                    return true;
                });

            if (data.length === 0) {
                alert('No data to export.');
                return;
            }

            // CSV helper: quote every cell and escape internal double-quotes.
            // Using comma separator so Excel opens columns correctly.
            function csvCell(value) {
                const str = String(value === null || value === undefined ? '' : value)
                    .replace(/\r?\n/g, ' ')   // flatten newlines
                    .replace(/"/g, '""');       // escape embedded quotes
                return `"${str}"`;
            }

            const headers = ['ID', 'Date/Time', 'Type', 'Category', 'Description', 'Location', 'Status', 'Reported By', 'Contact'];

            const rows = data.map((item, i) => {
                const ts = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
                const m  = String(ts.getMonth() + 1).padStart(2, '0');
                const d  = String(ts.getDate()).padStart(2, '0');
                const y  = ts.getFullYear();
                const h  = String(ts.getHours()).padStart(2, '0');
                const mi = String(ts.getMinutes()).padStart(2, '0');
                const dateStr   = `${m}/${d}/${y} ${h}:${mi}`;
                const isResolved = item.status === 'inactive' || item.isResolved;
                const typeLabel  = item.collection === 'Alerts' ? 'Alert'
                                 : item.collection === 'SOS'    ? 'SOS Emergency'
                                 : 'Emergency';

                return [
                    csvCell(`#${String(i + 1).padStart(3, '0')}`),
                    csvCell(dateStr),
                    csvCell(typeLabel),
                    csvCell(item.type || ''),
                    csvCell(item.details || item.description || item.message || ''),
                    csvCell(item.location || ''),
                    csvCell(isResolved ? 'Resolved' : 'Active'),
                    csvCell(item.reportedByName || item.reportedBy || 'Admin/System'),
                    csvCell(item.reportedByContactNumber || item.contactNumber || '')
                ].join(',');   // â† comma, not tab
            });

            // UTF-8 BOM so Excel detects encoding; \r\n line endings for max compatibility
            const BOM = '\uFEFF';
            const csv = BOM + [headers.map(csvCell).join(','), ...rows].join('\r\n');

            // .csv extension so Excel auto-splits on commas into columns
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `cdrrmo_report_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };

        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            setupTabListeners();
            loadAllData();
        });

        // Setup tab listeners
        function setupTabListeners() {
            document.querySelectorAll('.hub-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.hub-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    currentFilter = tab.dataset.tab;
                    renderEmergencies();
                });
            });
        }

        // Load all data
        async function loadAllData() {
            document.getElementById('loading-spinner').style.display = 'flex';
            document.getElementById('notification-list').style.display = 'none';
            
            try {
                allEmergencies = [];
                
                // Helper: load from a collection for both active and dispatched
                async function loadCollection(collectionName, emergencyType) {
                    const ref = collection(firestore, collectionName);
                    // Includes admin "Create Alert" documents (status: 'active'). Do not run a second
                    // query for dispatched â€” it duplicated every dispatched row (same doc matched twice).
                    const activeQuery = query(ref, where('status', 'in', ['pending', 'dispatched', 'ongoing', 'active']));
                    const activeSnapshot = await getDocs(activeQuery);
                    activeSnapshot.forEach(d => {
                        allEmergencies.push({ id: d.id, ...d.data(), emergencyType, collection: collectionName });
                    });
                }
                
                await Promise.all([
                    loadCollection('SOS', 'sos'),
                    loadCollection('Alerts', 'alert'),
                    loadCollection('Reports', 'report')
                ]);
                
                // Sort by timestamp (newest first)
                allEmergencies.sort((a, b) => {
                    const timeA = a.timestamp?.toDate?.() || new Date(0);
                    const timeB = b.timestamp?.toDate?.() || new Date(0);
                    return timeB - timeA;
                });
                
                // Load teams
                await loadTeams();
                
                // Update stats
                updateStats();
                
                // Render
                renderEmergencies();
                
            } catch (error) {
                console.error('Error loading data:', error);
            } finally {
                document.getElementById('loading-spinner').style.display = 'none';
            }
        }

        // Load available teams
        async function loadTeams() {
            try {
                const teamsRef = collection(firestore, 'Teams');
                const teamsQuery = query(teamsRef, where('status', '==', 'available'));
                const snapshot = await getDocs(teamsQuery);
                
                availableTeams = [];
                snapshot.forEach(doc => {
                    availableTeams.push({ id: doc.id, ...doc.data() });
                });
            } catch (error) {
                console.error('Error loading teams:', error);
            }
        }

        // Update statistics
        function updateStats() {
            const sosCount = allEmergencies.filter(e => e.emergencyType === 'sos').length;
            const alertCount = allEmergencies.filter(e => e.emergencyType === 'alert').length;
            const reportCount = allEmergencies.filter(e => e.emergencyType === 'report').length;
            const assignedCount = allEmergencies.filter(e => e.assignedTeamId).length;
            
            document.getElementById('sos-count').textContent = sosCount;
            document.getElementById('alert-count').textContent = alertCount;
            document.getElementById('report-count').textContent = reportCount;
            document.getElementById('assigned-count').textContent = assignedCount;
            
            // Update tab counts
            document.getElementById('all-tab-count').textContent = allEmergencies.length;
            document.getElementById('sos-tab-count').textContent = sosCount;
            document.getElementById('alert-tab-count').textContent = alertCount;
            document.getElementById('report-tab-count').textContent = reportCount;
        }

        // Render emergencies based on filter
        function renderEmergencies() {
            const list = document.getElementById('notification-list');
            const noNotifications = document.getElementById('no-notifications');
            
            let filtered = allEmergencies;
            if (currentFilter !== 'all') {
                filtered = allEmergencies.filter(e => e.emergencyType === currentFilter);
            }
            
            if (filtered.length === 0) {
                list.style.display = 'none';
                noNotifications.style.display = 'block';
                document.getElementById('footer-count').textContent = 'No active emergencies';
                return;
            }
            
            noNotifications.style.display = 'none';
            list.style.display = 'block';
            
            // Set footer text based on filter
            let filterLabel;
            switch (currentFilter) {
                case 'alert': filterLabel = 'alerts'; break;
                case 'report': filterLabel = 'emergencies'; break;
                case 'sos': filterLabel = 'SOS emergencies'; break;
                default: filterLabel = 'reports';
            }
            document.getElementById('footer-count').textContent = `Showing ${filtered.length} active ${filterLabel}`;
            
            list.innerHTML = filtered.map(emergency => {
                const typeClass = emergency.emergencyType;
                const timestamp = emergency.timestamp?.toDate?.() || new Date();
                const timeAgo = getTimeAgo(timestamp);
                const isAssigned = emergency.assignedTeamId;
                
                // Get type icon, label and creator based on 3 Legend Types
                let icon, label, statusLabel, createdBy;
                const isOfflineSOS = emergency.wasOffline || emergency.isOffline || emergency.sosSource === 'offline';
                
                switch (emergency.emergencyType) {
                    case 'alert':
                        icon = 'ðŸ””';
                        label = 'Alert';
                        statusLabel = 'ALERT';
                        createdBy = 'Admin';
                        break;
                    case 'report':
                        icon = 'âš ï¸';
                        label = 'Emergency';
                        statusLabel = 'EMERGENCY';
                        createdBy = 'Citizen';
                        break;
                    case 'sos':
                        icon = isOfflineSOS ? 'ðŸ“±' : 'ðŸ†˜';
                        label = isOfflineSOS ? 'Offline SOS' : 'SOS Emergency';
                        statusLabel = isOfflineSOS ? 'OFFLINE SOS' : 'SOS';
                        createdBy = 'Citizen';
                        break;
                    default:
                        icon = 'âš ï¸';
                        label = 'Emergency';
                        statusLabel = 'EMERGENCY';
                        createdBy = 'Unknown';
                }
                
                // Include incident category if available
                const category = emergency.type && emergency.emergencyType !== 'sos' ? ` - ${emergency.type}` : '';
                
                // Get citizen name and contact (handle multiple field names)
                const citizenName = emergency.reportedByName || emergency.reportedBy || 'Unknown';
                const citizenContact = emergency.reportedByContactNumber || emergency.contactNumber || '';
                
                return `
                    <li class="alert-item ${typeClass} ${isOfflineSOS ? 'offline-sos' : ''}" ${isOfflineSOS ? `style="cursor: pointer;" onclick="showOfflineSOSModal('${emergency.id}')"` : ''}>
                        <div class="alert-indicator"></div>
                        <div class="alert-details">
                            <p class="alert-title">${icon} ${label}${category}</p>
                            <p class="alert-location">
                                <i class="fas fa-map-marker-alt"></i>
                                ${emergency.location || 'Location not specified'}
                            </p>
                            <p class="alert-location" style="font-weight: 600; color: #1f2937;">
                                <i class="fas fa-user"></i>
                                ${citizenName}${citizenContact ? ` <a href="tel:${citizenContact}" style="color: #3b82f6;" onclick="event.stopPropagation();">â€¢ ðŸ“ž ${citizenContact}</a>` : ''}
                            </p>
                            ${isOfflineSOS ? `
                                <p class="alert-location" style="font-size: 0.8rem; color: #f97316; font-weight: 500;">
                                    <i class="fas fa-signal"></i>
                                    Status: Offline SOS (No internet when sent) - <strong>Click to view details</strong>
                                </p>
                            ` : ''}
                            <p class="alert-location" style="font-size: 0.8rem; color: #9ca3af;">
                                <i class="fas fa-user-tag"></i>
                                Created by: ${createdBy}
                            </p>
                            <small class="alert-timestamp">
                                <i class="far fa-clock"></i> ${timeAgo}
                            </small>
                            <span class="alert-status ${typeClass}">${statusLabel}</span>
                            ${isAssigned ? `<span class="alert-status assigned">âœ“ ${emergency.assignedTeamName || 'Team Assigned'}</span>` : ''}
                        </div>
                        <div class="alert-actions" onclick="event.stopPropagation();" style="flex-direction: column; gap: 8px;">
                            ${!isAssigned ? `
                                <button class="btn btn-sm" style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; width: 100%; padding: 10px; font-size: 14px;" onclick="event.stopPropagation(); showSendToResponderModal('${emergency.id}')">
                                    <i class="fas fa-paper-plane"></i> Send to Responder
                                </button>
                            ` : ''}
                            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); showDetails('${emergency.id}')" style="flex: 1;">
                                    <i class="fas fa-eye"></i> Details
                                </button>
                            </div>
                        </div>
                    </li>
                `;
            }).join('');
        }

        // Get time ago string
        function getTimeAgo(date) {
            const seconds = Math.floor((new Date() - date) / 1000);
            
            if (seconds < 60) return 'Just now';
            if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
            if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
            return `${Math.floor(seconds / 86400)} days ago`;
        }

        // Show details modal
        window.showDetails = function(id) {
            currentEmergency = allEmergencies.find(e => e.id === id);
            if (!currentEmergency) return;
            
            const modal = document.getElementById('detailModal');
            const header = document.getElementById('detail-header');
            const body = document.getElementById('detail-body');
            const title = document.getElementById('detail-title');
            
            // Set header color
            header.className = `detail-header ${currentEmergency.emergencyType}`;
            
            // Set title based on 3 Legend Types
            let typeLabel, createdBy;
            switch (currentEmergency.emergencyType) {
                case 'alert': 
                    typeLabel = 'ðŸ”” Alert'; 
                    createdBy = 'Admin';
                    break;
                case 'report': 
                    typeLabel = 'âš ï¸ Emergency'; 
                    createdBy = 'Citizen';
                    break;
                case 'sos': 
                    typeLabel = 'ðŸ†˜ SOS Emergency'; 
                    createdBy = 'Citizen';
                    break;
                default:
                    typeLabel = 'âš ï¸ Emergency';
                    createdBy = 'Unknown';
            }
            // Add incident category if available
            if (currentEmergency.type && currentEmergency.emergencyType !== 'sos') {
                typeLabel += ` - ${currentEmergency.type}`;
            }
            title.textContent = typeLabel;
            
            // Build body content
            const timestamp = currentEmergency.timestamp?.toDate?.() || new Date();
            const isOfflineSOS = currentEmergency.wasOffline || currentEmergency.isOffline || currentEmergency.sosSource === 'offline';
            const citizenName = currentEmergency.reportedByName || currentEmergency.reportedBy || 'Unknown';
            const citizenContact = currentEmergency.reportedByContactNumber || currentEmergency.contactNumber || '';
            
            body.innerHTML = `
                ${isOfflineSOS ? `
                    <div class="detail-row" style="background: rgba(249, 115, 22, 0.15); padding: 12px; border-radius: 8px; border: 1px solid #f97316;">
                        <i class="fas fa-signal" style="color: #f97316;"></i>
                        <div>
                            <div class="detail-label" style="color: #f97316;">Offline SOS</div>
                            <div class="detail-value" style="color: #f97316; font-weight: 600;">Citizen had no internet when sending this SOS</div>
                        </div>
                    </div>
                ` : ''}
                <div class="detail-row" style="background: rgba(99, 102, 241, 0.1); padding: 12px; border-radius: 8px;">
                    <i class="fas fa-user-tag" style="color: #6366f1;"></i>
                    <div>
                        <div class="detail-label" style="color: #6366f1;">Created By</div>
                        <div class="detail-value" style="color: #6366f1; font-weight: 600;">${createdBy}</div>
                    </div>
                </div>
                ${currentEmergency.type && currentEmergency.emergencyType !== 'sos' ? `
                    <div class="detail-row">
                        <i class="fas fa-folder"></i>
                        <div>
                            <div class="detail-label">Incident Category</div>
                            <div class="detail-value">${currentEmergency.type}</div>
                        </div>
                    </div>
                ` : ''}
                <div class="detail-row">
                    <i class="fas fa-map-marker-alt"></i>
                    <div>
                        <div class="detail-label">Location</div>
                        <div class="detail-value">${currentEmergency.location || 'Not specified'}</div>
                    </div>
                </div>
                <div class="detail-row" style="background: rgba(34, 197, 94, 0.1); padding: 12px; border-radius: 8px;">
                    <i class="fas fa-user" style="color: #22c55e;"></i>
                    <div>
                        <div class="detail-label" style="color: #22c55e;">Citizen Name</div>
                        <div class="detail-value" style="color: #22c55e; font-weight: 600;">${citizenName}</div>
                    </div>
                </div>
                ${citizenContact ? `
                    <div class="detail-row" style="background: rgba(59, 130, 246, 0.1); padding: 12px; border-radius: 8px;">
                        <i class="fas fa-phone" style="color: #3b82f6;"></i>
                        <div>
                            <div class="detail-label" style="color: #3b82f6;">Phone Number</div>
                            <div class="detail-value">
                                <a href="tel:${citizenContact}" style="color: #3b82f6; font-weight: 600; font-size: 1.1rem;">${citizenContact}</a>
                            </div>
                        </div>
                    </div>
                ` : ''}
                ${currentEmergency.description || currentEmergency.message ? `
                    <div class="detail-row">
                        <i class="fas fa-comment"></i>
                        <div>
                            <div class="detail-label">Description</div>
                            <div class="detail-value">${currentEmergency.description || currentEmergency.message}</div>
                        </div>
                    </div>
                ` : ''}
                <div class="detail-row">
                    <i class="fas fa-clock"></i>
                    <div>
                        <div class="detail-label">Reported At</div>
                        <div class="detail-value">${timestamp.toLocaleString()}</div>
                    </div>
                </div>
                ${currentEmergency.assignedTeamId ? `
                    <div class="detail-row" style="background: #d1fae5; padding: 12px; border-radius: 8px;">
                        <i class="fas fa-users" style="color: #059669;"></i>
                        <div>
                            <div class="detail-label" style="color: #059669;">Assigned Team</div>
                            <div class="detail-value" style="color: #059669; font-weight: 600;">${currentEmergency.assignedTeamName || 'Team Assigned'}</div>
                        </div>
                    </div>
                ` : ''}
                <div class="detail-row">
                    <i class="fas fa-fingerprint"></i>
                    <div>
                        <div class="detail-label">Emergency ID</div>
                        <div class="detail-value" style="font-family: monospace; font-size: 0.85rem;">${currentEmergency.id}</div>
                    </div>
                </div>
            `;
            
            modal.classList.add('active');
        };

        // Close detail modal
        window.closeDetailModal = function() {
            document.getElementById('detailModal').classList.remove('active');
            currentEmergency = null;
        };

        // Open directions
        window.openDirections = function() {
            if (!currentEmergency) return;
            
            const lat = currentEmergency.coordinates?.latitude || currentEmergency.coordinates?.lat;
            const lng = currentEmergency.coordinates?.longitude || currentEmergency.coordinates?.lng;
            
            if (lat && lng) {
                window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`, '_blank');
            } else {
                alert('Coordinates not available for this emergency.');
            }
        };

        // Show assign modal
        window.showAssignModal = function(id) {
            currentEmergency = allEmergencies.find(e => e.id === id);
            if (!currentEmergency) return;
            
            const modal = document.getElementById('assignModal');
            const infoDiv = document.getElementById('assign-emergency-info');
            const select = document.getElementById('team-select');
            
            // Show emergency info
            let typeLabel;
            switch (currentEmergency.emergencyType) {
                case 'sos': typeLabel = 'ðŸ†˜ SOS Emergency'; break;
                case 'alert': typeLabel = 'ðŸ”” ' + (currentEmergency.type || 'Alert'); break;
                case 'report': typeLabel = 'ðŸ“‹ ' + (currentEmergency.type || 'Report'); break;
            }
            
            infoDiv.innerHTML = `
                <div style="background: var(--gray-100); padding: 16px; border-radius: var(--radius); margin-bottom: 16px;">
                    <p style="margin: 0 0 8px; font-weight: 600;">${typeLabel}</p>
                    <p style="margin: 0; color: var(--gray-600);">
                        <i class="fas fa-map-marker-alt"></i> ${currentEmergency.location || 'Location not specified'}
                    </p>
                </div>
            `;
            
            // Populate team dropdown
            select.innerHTML = '<option value="">-- Select a Team --</option>';
            
            if (availableTeams.length === 0) {
                select.innerHTML += '<option value="" disabled>No available teams</option>';
            } else {
                // Group by type
                const teamsByType = {};
                availableTeams.forEach(team => {
                    const type = team.type || 'other';
                    if (!teamsByType[type]) teamsByType[type] = [];
                    teamsByType[type].push(team);
                });
                
                Object.keys(teamsByType).sort().forEach(type => {
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = type.charAt(0).toUpperCase() + type.slice(1) + ' Teams';
                    
                    teamsByType[type].forEach(team => {
                        const option = document.createElement('option');
                        option.value = team.id;
                        option.textContent = `${team.name} (${team.members || 0} members)`;
                        option.dataset.teamName = team.name;
                        option.dataset.teamType = team.type;
                        optgroup.appendChild(option);
                    });
                    
                    select.appendChild(optgroup);
                });
            }
            
            modal.classList.add('active');
        };

        // Close assign modal
        window.closeAssignModal = function() {
            document.getElementById('assignModal').classList.remove('active');
        };

        // Dispatch team
        window.dispatchTeam = async function() {
            const select = document.getElementById('team-select');
            const teamId = select.value;
            
            if (!teamId) {
                alert('Please select a team to dispatch.');
                return;
            }
            
            if (!currentEmergency) {
                alert('No emergency selected.');
                return;
            }
            
            try {
                const selectedOption = select.options[select.selectedIndex];
                const teamName = selectedOption.dataset.teamName;
                const teamType = selectedOption.dataset.teamType;
                
                const emergencyRef = doc(firestore, currentEmergency.collection, currentEmergency.id);
                const priorSnap = await getDoc(emergencyRef);
                const prior = priorSnap.exists() ? priorSnap.data() : {};
                const prevTeamId = prior.assignedTeamId || prior.assignedTeam;
                if (prevTeamId && prevTeamId !== teamId) {
                    await releasePreviousTeamOnReassign(prevTeamId, currentEmergency.id, 'report_hub_dispatch');
                }

                // Update emergency with dispatch info
                await updateDoc(emergencyRef, {
                    status: 'dispatched',
                    assignedTeamId: teamId,
                    assignedTeamName: teamName,
                    assignedTeamType: teamType,
                    assignedResponderId: teamId,
                    assignedResponderName: teamName,
                    dispatchTime: serverTimestamp(),
                    assignedAt: serverTimestamp(),
                    assignedBy: 'admin'
                });
                
                // Update team status to busy/on-mission
                const teamRef = doc(firestore, 'Teams', teamId);
                const lat = currentEmergency.coordinates?.latitude || currentEmergency.coordinates?.lat || 0;
                const lng = currentEmergency.coordinates?.longitude || currentEmergency.coordinates?.lng || 0;
                
                await updateDoc(teamRef, {
                    status: 'on-mission',
                    availability: 'Busy',
                    currentMission: currentEmergency.id,
                    missionType: currentEmergency.emergencyType,
                    missionLocation: currentEmergency.location,
                    missionCoordinates: { latitude: lat, longitude: lng },
                    missionStartedAt: serverTimestamp()
                });

                try {
                    const phones = await getPhonesForTeamDispatch(teamId, teamName);
                    const cName = currentEmergency.reportedByName || currentEmergency.reportedBy || 'Unknown';
                    const cPhone = currentEmergency.reportedByContactNumber || currentEmergency.contactNumber || 'N/A';
                    const loc = currentEmergency.location || 'Unknown';
                    let dispatchMsg = `[CDRRMO] DISPATCH ALERT\nTeam: ${teamName}\nCitizen: ${cName}\nPhone: ${cPhone}\nLocation: ${loc}\n`;
                    if (lat && lng) dispatchMsg += `Map: https://maps.google.com/?q=${lat},${lng}\n`;
                    dispatchMsg += `Respond immediately.`;
                    for (const p of phones) {
                        notifyUser(p, dispatchMsg).catch((e) => console.warn('[ReportHub] dispatchTeam responder SMS', e));
                    }
                } catch (e) {
                    console.warn('[ReportHub] dispatchTeam team SMS', e);
                }

                const cPh = currentEmergency.reportedByContactNumber || currentEmergency.contactNumber;
                if (cPh && String(cPh).trim()) {
                    const et = (currentEmergency.emergencyType || '').toString().toLowerCase();
                    const ct = et === 'sos' ? 'SOS' : et === 'report' ? 'emergency report' : 'emergency';
                    const cmsg = `[CDRRMO] Your ${ct} has been assigned to team "${teamName}". Responders were notified.\nRef: ${currentEmergency.id}\nLocation: ${currentEmergency.location || 'See app'}`;
                    notifyUser(cPh, cmsg).catch((e) => console.warn('Citizen assign SMS', e));
                }
                
                alert(`Team "${teamName}" has been dispatched!\n\nThe team will be notified and can see the location on their responder app.`);
                
                closeAssignModal();
                loadAllData(); // Refresh data
                
            } catch (error) {
                console.error('Error dispatching team:', error);
                alert('Failed to dispatch team. Please try again.');
            }
        };

        // Refresh data
        window.refreshData = function() {
            loadAllData();
        };

        // Show "Send to Responder" Modal with citizen credentials auto-filled
        window.showSendToResponderModal = async function(id) {
            const emergency = allEmergencies.find(e => e.id === id);
            if (!emergency) return;
            
            // Get citizen info
            const citizenName = emergency.reportedByName || emergency.reportedBy || 'Unknown';
            const citizenPhone = emergency.reportedByContactNumber || emergency.contactNumber || '';
            const location = emergency.location || 'Unknown location';
            const lat = emergency.coordinates?.latitude || emergency.coordinates?.lat || '';
            const lng = emergency.coordinates?.longitude || emergency.coordinates?.lng || '';
            const details = emergency.details || emergency.description || 'Emergency assistance requested';
            const isOfflineSOS = emergency.wasOffline || emergency.isOffline || emergency.sosSource === 'offline';
            
            // Remove existing modal
            document.getElementById('sendResponderModal')?.remove();
            
            // Build team options
            let teamOptions = '<option value="">-- Choose a Team --</option>';
            if (availableTeams.length > 0) {
                // Group by type
                const teamsByType = {};
                availableTeams.forEach(team => {
                    const type = team.type || 'general';
                    if (!teamsByType[type]) teamsByType[type] = [];
                    teamsByType[type].push(team);
                });
                
                Object.keys(teamsByType).sort().forEach(type => {
                    teamOptions += `<optgroup label="${type.charAt(0).toUpperCase() + type.slice(1)} Teams">`;
                    teamsByType[type].forEach(team => {
                        teamOptions += `<option value="${team.id}" data-name="${team.name}" data-type="${team.type}">${team.name} (${team.members || 0} members)</option>`;
                    });
                    teamOptions += '</optgroup>';
                });
            } else {
                teamOptions += '<option value="" disabled>No available teams</option>';
            }
            
            // Create modal
            const modalDiv = document.createElement('div');
            modalDiv.id = 'sendResponderModal';
            modalDiv.className = 'modal-overlay active';
            modalDiv.innerHTML = `
                <div class="dispatch-modal-content">
                    <div class="detail-header" style="background: linear-gradient(135deg, #8b5cf6, #7c3aed);">
                        <h3>ðŸ“¤ Send SOS to Responder Team</h3>
                        <button class="detail-close" onclick="closeSendResponderModal()">&times;</button>
                    </div>
                    <div class="modal-body" style="max-height: 65vh; overflow-y: auto; padding: 20px;">
                        
                        <!-- Emergency Type Badge -->
                        <div style="text-align: center; margin-bottom: 20px;">
                            <span style="display: inline-block; padding: 10px 24px; background: ${isOfflineSOS ? 'linear-gradient(135deg, #f97316, #ea580c)' : emergency.emergencyType === 'sos' ? 'linear-gradient(135deg, #ef4444, #dc2626)' : emergency.emergencyType === 'alert' ? 'linear-gradient(135deg, #f97316, #ea580c)' : 'linear-gradient(135deg, #eab308, #ca8a04)'}; color: white; border-radius: 25px; font-weight: bold; font-size: 16px;">
                                ${isOfflineSOS ? 'ðŸ“± OFFLINE SOS ALERT' : emergency.emergencyType === 'sos' ? 'ðŸš¨ SOS EMERGENCY' : emergency.emergencyType === 'alert' ? 'ðŸ”” ALERT' : 'âš ï¸ EMERGENCY'}
                            </span>
                        </div>
                        
                        <!-- Citizen Credentials Card -->
                        <div style="background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 2px solid #22c55e; border-radius: 16px; padding: 20px; margin-bottom: 20px;">
                            <h4 style="margin: 0 0 16px 0; color: #166534; font-size: 18px;">
                                ðŸ‘¤ Citizen Credentials (Auto-filled)
                            </h4>
                            
                            <div style="display: grid; gap: 12px;">
                                <!-- Name -->
                                <div style="display: flex; align-items: center; gap: 15px; padding: 12px 15px; background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                                    <div style="width: 40px; height: 40px; background: #dcfce7; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px;">ðŸ‘¤</div>
                                    <div style="flex: 1;">
                                        <div style="font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px;">Full Name</div>
                                        <div style="font-size: 18px; font-weight: 700; color: #1f2937;">${citizenName}</div>
                                    </div>
                                </div>
                                
                                <!-- Phone -->
                                <div style="display: flex; align-items: center; gap: 15px; padding: 12px 15px; background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                                    <div style="width: 40px; height: 40px; background: #dbeafe; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px;">ðŸ“ž</div>
                                    <div style="flex: 1;">
                                        <div style="font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px;">Phone Number</div>
                                        <div style="font-size: 18px; font-weight: 700; color: #3b82f6;">${citizenPhone || 'Not provided'}</div>
                                    </div>
                                </div>
                                
                                <!-- Location -->
                                <div style="display: flex; align-items: center; gap: 15px; padding: 12px 15px; background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                                    <div style="width: 40px; height: 40px; background: #fee2e2; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px;">ðŸ“</div>
                                    <div style="flex: 1;">
                                        <div style="font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px;">Location</div>
                                        <div style="font-size: 14px; font-weight: 600; color: #1f2937;">${location}</div>
                                        ${lat && lng ? `<div style="font-size: 12px; color: #6b7280; margin-top: 2px;">GPS: ${lat}, ${lng}</div>` : ''}
                                    </div>
                                    ${lat && lng ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving" target="_blank" class="btn btn-sm" style="background: #3b82f6; color: white;">ðŸ§­ Directions</a>` : ''}
                                </div>
                                
                                <!-- Details -->
                                <div style="padding: 12px 15px; background: white; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                                    <div style="font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px; margin-bottom: 6px;">ðŸ“ Emergency Details</div>
                                    <div style="font-size: 14px; color: #374151;">${details}</div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Team Selection -->
                        <div style="background: #f8fafc; border: 2px solid #8b5cf6; border-radius: 16px; padding: 20px;">
                            <h4 style="margin: 0 0 16px 0; color: #6d28d9; font-size: 18px;">
                                ðŸ‘¥ Select Responder Team to Dispatch
                            </h4>
                            
                            <select id="dispatch-team-select" style="width: 100%; padding: 14px; border: 2px solid #a78bfa; border-radius: 10px; font-size: 16px; background: white; cursor: pointer;">
                                ${teamOptions}
                            </select>
                            
                            ${availableTeams.length === 0 ? `
                                <p style="color: #ef4444; margin: 12px 0 0 0; font-size: 14px;">
                                    <i class="fas fa-exclamation-triangle"></i> No teams are currently available. Check Team Management page.
                                </p>
                            ` : ''}
                        </div>
                        
                        <!-- SMS Notification Option -->
                        <div style="background: #dcfce7; border: 1px solid #22c55e; border-radius: 12px; padding: 15px; margin-top: 16px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <span style="font-size: 24px;">ðŸ“±</span>
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; color: #166534;">SMS Notification <span style="background: #22c55e; color: white; padding: 2px 8px; border-radius: 10px; font-size: 11px;">ACTIVE</span></div>
                                    <div style="font-size: 13px; color: #166534;">Responders will receive SMS with citizen info.</div>
                                </div>
                            </div>
                            <label style="display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer;">
                                <input type="checkbox" id="dispatch-sms-checkbox" checked style="width: 18px; height: 18px; accent-color: #22c55e;">
                                <span style="font-size: 14px; color: #166534; font-weight: 500;">Send SMS to team members</span>
                            </label>
                        </div>
                        
                    </div>
                    <div class="modal-footer" style="padding: 16px 20px; border-top: 1px solid #e5e7eb; display: flex; gap: 12px; justify-content: flex-end;">
                        <button class="btn btn-secondary" onclick="closeSendResponderModal()">Cancel</button>
                        <button class="btn" style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 12px 28px; font-weight: bold; font-size: 16px;" onclick="dispatchSOSToTeam('${id}')">
                            <i class="fas fa-paper-plane"></i> ðŸ“¤ Send to Responder
                        </button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modalDiv);
        };
        
        // Close Send Responder Modal
        window.closeSendResponderModal = function() {
            document.getElementById('sendResponderModal')?.remove();
        };
        
        // Dispatch SOS to selected team (SMS via ./js/smsService.js â†’ Mocean form-urlencoded, same as alerts)
        window.dispatchSOSToTeam = async function(id) {
            const select = document.getElementById('dispatch-team-select');
            const teamId = select?.value;
            const sendSMSEnabled = document.getElementById('dispatch-sms-checkbox')?.checked;
            
            if (!teamId) {
                alert('Please select a responder team to dispatch.');
                return;
            }
            
            const selectedOption = select.options[select.selectedIndex];
            const teamName = selectedOption.dataset.name;
            const teamType = selectedOption.dataset.type;
            
            try {
                const emergency = allEmergencies.find(e => e.id === id);
                if (!emergency) {
                    alert('Emergency not found');
                    return;
                }
                
                const emergencyRef = doc(firestore, emergency.collection, id);
                const priorSnap = await getDoc(emergencyRef);
                const prior = priorSnap.exists() ? priorSnap.data() : {};
                const prevTeamId = prior.assignedTeamId || prior.assignedTeam;
                if (prevTeamId && prevTeamId !== teamId) {
                    await releasePreviousTeamOnReassign(prevTeamId, id, 'report_hub_sos_modal');
                }

                // Update emergency with dispatch info
                await updateDoc(emergencyRef, {
                    status: 'dispatched',
                    assignedTeamId: teamId,
                    assignedTeamName: teamName,
                    assignedTeamType: teamType,
                    assignedResponderId: teamId,
                    assignedResponderName: teamName,
                    dispatchTime: serverTimestamp(),
                    assignedAt: serverTimestamp(),
                    assignedBy: 'admin',
                    smsSent: sendSMSEnabled
                });
                
                // Update team status to busy/on-mission
                const teamRef = doc(firestore, 'Teams', teamId);
                const lat = emergency.coordinates?.latitude || emergency.coordinates?.lat || 0;
                const lng = emergency.coordinates?.longitude || emergency.coordinates?.lng || 0;
                
                await updateDoc(teamRef, {
                    status: 'on-mission',
                    availability: 'Busy',
                    currentMission: id,
                    missionType: emergency.emergencyType,
                    missionLocation: emergency.location || 'Unknown',
                    missionCoordinates: { latitude: lat, longitude: lng },
                    missionStartedAt: serverTimestamp()
                });
                
                // Send SMS if enabled
                let smsSuccess = 0, smsFailed = 0;
                if (sendSMSEnabled) {
                    try {
                        const phones = await getPhonesForTeamDispatch(teamId, teamName);
                        console.log('[ReportHub] Dispatch responder phones count:', phones.length, phones);
                        
                        // Create SMS message
                        const citizenName = emergency.reportedByName || emergency.reportedBy || 'Unknown';
                        const citizenPhone = emergency.reportedByContactNumber || emergency.contactNumber || 'N/A';
                        const location = emergency.location || 'Unknown';
                        
                        let smsMessage = `ðŸš¨ CDRRMO SOS ALERT!\n`;
                        smsMessage += `Team: ${teamName}\n`;
                        smsMessage += `Citizen: ${citizenName}\n`;
                        smsMessage += `Phone: ${citizenPhone}\n`;
                        smsMessage += `Location: ${location}\n`;
                        if (lat && lng) smsMessage += `Map: https://maps.google.com/?q=${lat},${lng}`;
                        
                        // Send to all phones (same Mocean path as admin alerts)
                        for (const phone of phones) {
                            const result = await notifyUser(phone, smsMessage);
                            console.log('[ReportHub] Dispatch SMS result for', phone, result.success, result.error || '');
                            if (result.success) smsSuccess++;
                            else smsFailed++;
                        }
                    } catch (smsError) {
                        console.error('SMS Error:', smsError);
                    }
                }

                try {
                    const citizenNotifyPhone = emergency.reportedByContactNumber || emergency.contactNumber;
                    const loc = emergency.location || 'Unknown';
                    if (citizenNotifyPhone && String(citizenNotifyPhone).trim() && citizenNotifyPhone !== 'N/A') {
                        const et = (emergency.emergencyType || '').toString().toLowerCase();
                        const ct = et === 'sos' ? 'SOS' : et === 'report' ? 'emergency report' : 'emergency';
                        const cmsg = `[CDRRMO] Your ${ct} has been assigned to team "${teamName}". Responders were notified.\nRef: ${id}\nLocation: ${loc}`;
                        const cr = await notifyUser(citizenNotifyPhone, cmsg);
                        if (!cr.success) console.warn('Citizen assign SMS failed', cr);
                    }
                } catch (ce) {
                    console.warn('Citizen assign SMS', ce);
                }
                
                let alertMsg = `âœ… SOS Successfully Sent!\n\nTeam "${teamName}" has been dispatched.`;
                if (sendSMSEnabled) {
                    if (smsSuccess > 0) alertMsg += `\n\nðŸ“± SMS sent to ${smsSuccess} responder(s).`;
                    if (smsFailed > 0) alertMsg += `\nâš ï¸ ${smsFailed} SMS failed.`;
                }
                alertMsg += `\n\nCitizen Info:\nâ€¢ Name: ${emergency.reportedByName || emergency.reportedBy || 'Unknown'}\nâ€¢ Phone: ${emergency.reportedByContactNumber || emergency.contactNumber || 'N/A'}\nâ€¢ Location: ${emergency.location || 'Unknown'}`;
                
                alert(alertMsg);
                
                closeSendResponderModal();
                loadAllData();
                
            } catch (error) {
                console.error('Error dispatching SOS:', error);
                alert('Error dispatching SOS: ' + error.message);
            }
        };

        // Show Offline SOS Modal with pre-filled data
        window.showOfflineSOSModal = function(id) {
            const emergency = allEmergencies.find(e => e.id === id);
            if (!emergency) return;
            
            // Get citizen info
            const citizenName = emergency.reportedByName || emergency.reportedBy || '';
            const citizenPhone = emergency.reportedByContactNumber || emergency.contactNumber || '';
            const location = emergency.location || '';
            const details = emergency.details || emergency.description || '';
            const lat = emergency.coordinates?.latitude || emergency.coordinates?.lat || '';
            const lng = emergency.coordinates?.longitude || emergency.coordinates?.lng || '';
            const offlineTime = emergency.offlineCreatedAt || emergency.offlineQueuedAt || '';
            const syncedTime = emergency.syncedAt || '';
            
            // Remove existing modal if any
            document.getElementById('offlineSOSModal')?.remove();
            
            // Create modal
            const modalDiv = document.createElement('div');
            modalDiv.id = 'offlineSOSModal';
            modalDiv.className = 'modal-overlay active';
            modalDiv.innerHTML = `
                <div class="dispatch-modal-content">
                    <div class="detail-header sos" style="background: linear-gradient(135deg, #f97316, #ea580c);">
                        <h3>ðŸ“± Offline SOS Details</h3>
                        <button class="detail-close" onclick="closeOfflineSOSModal()">&times;</button>
                    </div>
                    <div class="modal-body" style="max-height: 70vh; overflow-y: auto; padding: 20px;">
                        <!-- Offline Status Banner -->
                        <div style="background: #fff7ed; border: 2px solid #f97316; border-radius: 10px; padding: 15px; margin-bottom: 20px;">
                            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                                <span style="font-size: 24px;">ðŸ“±</span>
                                <strong style="color: #c2410c; font-size: 1.1rem;">This SOS was sent while citizen was offline</strong>
                            </div>
                            ${offlineTime ? `<p style="margin: 0; color: #7c2d12; font-size: 0.9rem;"><i class="fas fa-clock"></i> Created offline: <strong>${new Date(offlineTime).toLocaleString()}</strong></p>` : ''}
                            ${syncedTime ? `<p style="margin: 5px 0 0 0; color: #7c2d12; font-size: 0.9rem;"><i class="fas fa-cloud"></i> Synced at: <strong>${new Date(syncedTime).toLocaleString()}</strong></p>` : ''}
                        </div>
                        
                        <!-- Form Fields -->
                        <div style="display: grid; gap: 16px;">
                            <div class="form-group">
                                <label style="font-weight: 600; color: #374151; margin-bottom: 5px; display: block;">
                                    <i class="fas fa-user" style="color: #22c55e;"></i> Citizen Name
                                </label>
                                <input type="text" id="offline-name" class="form-control" value="${citizenName}" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">
                            </div>
                            
                            <div class="form-group">
                                <label style="font-weight: 600; color: #374151; margin-bottom: 5px; display: block;">
                                    <i class="fas fa-phone" style="color: #3b82f6;"></i> Phone Number
                                </label>
                                <div style="display: flex; gap: 10px;">
                                    <input type="tel" id="offline-phone" class="form-control" value="${citizenPhone}" style="flex: 1; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">
                                </div>
                            </div>
                            
                            <div class="form-group">
                                <label style="font-weight: 600; color: #374151; margin-bottom: 5px; display: block;">
                                    <i class="fas fa-map-marker-alt" style="color: #ef4444;"></i> Location
                                </label>
                                <input type="text" id="offline-location" class="form-control" value="${location}" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">
                            </div>
                            
                            <div class="form-group">
                                <label style="font-weight: 600; color: #374151; margin-bottom: 5px; display: block;">
                                    <i class="fas fa-info-circle" style="color: #8b5cf6;"></i> Details / Message
                                </label>
                                <textarea id="offline-details" class="form-control" rows="3" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">${details}</textarea>
                            </div>
                            
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                                <div class="form-group">
                                    <label style="font-weight: 600; color: #374151; margin-bottom: 5px; display: block;">Latitude</label>
                                    <input type="number" id="offline-lat" step="any" class="form-control" value="${lat}" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">
                                </div>
                                <div class="form-group">
                                    <label style="font-weight: 600; color: #374151; margin-bottom: 5px; display: block;">Longitude</label>
                                    <input type="number" id="offline-lng" step="any" class="form-control" value="${lng}" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;">
                                </div>
                            </div>
                            
                            ${lat && lng ? `
                            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                                <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" class="btn" style="background: #3b82f6; color: white; flex: 1; text-align: center; text-decoration: none;">
                                    ðŸ—ºï¸ View on Map
                                </a>
                                <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving" target="_blank" class="btn" style="background: #10b981; color: white; flex: 1; text-align: center; text-decoration: none;">
                                    ðŸ§­ Get Directions
                                </a>
                            </div>
                            ` : ''}
                        </div>
                    </div>
                    <div class="modal-footer" style="padding: 15px 20px; border-top: 1px solid #e5e7eb; display: flex; gap: 10px; justify-content: flex-end;">
                        <button class="btn btn-secondary" onclick="closeOfflineSOSModal()">Cancel</button>
                        <button class="btn" style="background: #f97316; color: white;" onclick="updateOfflineSOS('${id}')">
                            <i class="fas fa-save"></i> Update SOS
                        </button>
                        <button class="btn btn-primary" onclick="closeOfflineSOSModal(); showAssignModal('${id}')">
                            <i class="fas fa-paper-plane"></i> Dispatch Team
                        </button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modalDiv);
        };
        
        // Close Offline SOS Modal
        window.closeOfflineSOSModal = function() {
            document.getElementById('offlineSOSModal')?.remove();
        };
        
        // Update Offline SOS
        window.updateOfflineSOS = async function(id) {
            try {
                const name = document.getElementById('offline-name')?.value || '';
                const phone = document.getElementById('offline-phone')?.value || '';
                const location = document.getElementById('offline-location')?.value || '';
                const details = document.getElementById('offline-details')?.value || '';
                const lat = parseFloat(document.getElementById('offline-lat')?.value);
                const lng = parseFloat(document.getElementById('offline-lng')?.value);
                
                const updateData = {
                    reportedBy: name,
                    reportedByName: name,
                    contactNumber: phone,
                    reportedByContactNumber: phone,
                    location: location,
                    details: details,
                    updatedAt: serverTimestamp(),
                    updatedBy: 'admin'
                };
                
                if (!isNaN(lat) && !isNaN(lng)) {
                    updateData.coordinates = { latitude: lat, longitude: lng };
                }
                
                const emergency = allEmergencies.find(e => e.id === id);
                if (!emergency) {
                    alert('Emergency not found');
                    return;
                }
                
                const docRef = doc(firestore, emergency.collection, id);
                await updateDoc(docRef, updateData);
                
                alert('Offline SOS updated successfully!');
                closeOfflineSOSModal();
                loadAllData();
                
            } catch (error) {
                console.error('Error updating offline SOS:', error);
                alert('Error updating SOS: ' + error.message);
            }
        };