/**
 * team-manager.js — CDRRMO Admin Panel
 * ─────────────────────────────────────────────────────────────────────────────
 * SMS FIX: assignToEmergency() now:
 *   1. Fetches the full emergency document (SOS / Report) to get citizen details
 *   2. Queries the Responder collection for all members of the assigned team
 *      using the `respAssignedTeamId` field
 *   3. Collects each responder's `respPhone` number
 *   4. Sends a Mocean SMS to every team member via smsService
 */

import {
    firestore,
    collection,
    addDoc,
    setDoc,
    getDoc,
    getDocs,
    updateDoc,
    deleteDoc,
    doc,
    query,
    orderBy,
    limit,
    onSnapshot,
    where,
    serverTimestamp
} from './firebase-api.js';
import adminLogger from './admin-logger.js';
import smsService, { notifyCitizenTeamAssigned } from './smsService.js'; // ← SMS integration
import { getPhonesForTeamDispatch } from './team-dispatch-phones.js';
import { initAdminRealtimeHub } from './admin-notifications.js';
import { releasePreviousTeamOnReassign } from './release-team-on-resolve.js';

class TeamManager {
    constructor() {
        this.teamCollection       = collection(firestore, 'Teams');
        this.alertsCollection     = collection(firestore, 'Alerts');
        this.sosCollection        = collection(firestore, 'SOS');
        this.responderCollection  = collection(firestore, 'Responder'); // ← needed for SMS

        this.teamsCache       = [];
        this.activeEmergencies = [];

        this.defaultTeams = [
            { name: 'Police Unit Alpha',     type: 'police',  members: 4, location: 'Police Station 1',  vehicle: 'Patrol Car 101',    contact: '+639000000001' },
            { name: 'Police Unit Bravo',     type: 'police',  members: 4, location: 'Police Station 2',  vehicle: 'Patrol Car 102',    contact: '+639000000002' },
            { name: 'Police SWAT Team',      type: 'police',  members: 8, location: 'Police HQ',         vehicle: 'SWAT Van 001',      contact: '+639000000003' },
            { name: 'Fire Brigade Alpha',    type: 'fire',    members: 6, location: 'Fire Station 1',    vehicle: 'Fire Truck 201',    contact: '+639000000011' },
            { name: 'Fire Brigade Bravo',    type: 'fire',    members: 6, location: 'Fire Station 2',    vehicle: 'Fire Truck 202',    contact: '+639000000012' },
            { name: 'Hazmat Response Team',  type: 'fire',    members: 5, location: 'Fire Station HQ',   vehicle: 'Hazmat Unit 001',   contact: '+639000000013' },
            { name: 'Medical Team Alpha',    type: 'medical', members: 4, location: 'Hospital 1',        vehicle: 'Ambulance 301',     contact: '+639000000021' },
            { name: 'Medical Team Bravo',    type: 'medical', members: 4, location: 'Hospital 2',        vehicle: 'Ambulance 302',     contact: '+639000000022' },
            { name: 'Paramedic Response Unit', type: 'medical', members: 3, location: 'Medical Center', vehicle: 'Ambulance 303',     contact: '+639000000023' },
            { name: 'Search & Rescue Alpha', type: 'rescue',  members: 6, location: 'CDRRMO HQ',         vehicle: 'Rescue Van 401',    contact: '+639000000031' },
            { name: 'Search & Rescue Bravo', type: 'rescue',  members: 6, location: 'CDRRMO Station 2',  vehicle: 'Rescue Van 402',    contact: '+639000000032' },
            { name: 'K9 Search Unit',        type: 'rescue',  members: 4, location: 'CDRRMO HQ',         vehicle: 'K9 Unit 001',       contact: '+639000000033' },
            { name: 'Flood Response Alpha',  type: 'rescue',  members: 5, location: 'CDRRMO HQ',         vehicle: 'Rescue Boat 501',   contact: '+639000000041' },
            { name: 'Flood Response Bravo',  type: 'rescue',  members: 5, location: 'River Station',     vehicle: 'Rescue Boat 502',   contact: '+639000000042' },
            { name: 'Evacuation Team',       type: 'rescue',  members: 8, location: 'CDRRMO HQ',         vehicle: 'Evacuation Bus 001',contact: '+639000000043' },
        ];

        this.setupRealtimeListener();
        this.loadActiveEmergencies();
        this.renderDefaultTeams();
    }

    // ─── REAL-TIME LISTENER ──────────────────────────────────────────────────

    setupRealtimeListener() {
        const q = query(this.teamCollection, orderBy('createdAt', 'desc'));

        onSnapshot(q, (snapshot) => {
            this.teamsCache = [];
            snapshot.forEach(d => {
                this.teamsCache.push({ id: d.id, ...d.data() });
            });
            this.updateUI();
            this.updateStats();
        }, (error) => {
            console.error('Error listening to teams:', error);
        });
    }

    // ─── UI HELPERS ──────────────────────────────────────────────────────────

    updateUI() {
        this.renderGridView();
        this.renderTableView();
        this.updateDefaultTeamsUI();
    }

    getTeamIcon(type) {
        const icons = {
            medical: 'fa-kit-medical',
            fire:    'fa-fire-extinguisher',
            rescue:  'fa-life-ring',
            police:  'fa-shield-halved'
        };
        return icons[type] || 'fa-users';
    }

    getTypeColor(type) {
        const colors = {
            medical: '#e74c3c',
            fire:    '#e67300',
            rescue:  '#3498db',
            police:  '#9b59b6'
        };
        return colors[type] || '#7f8c8d';
    }

    renderGridView() {
        const grid = document.getElementById('teamsGrid');
        if (this.teamsCache.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1/-1;">
                    <i class="fas fa-users-slash"></i>
                    <h3>No Teams Found</h3>
                    <p>Click "Add New Team" to create your first response team.</p>
                </div>`;
            return;
        }

        grid.innerHTML = this.teamsCache.map(team => `
            <div class="team-card">
                <div class="team-card-header ${team.type}">
                    <div class="team-icon ${team.type}">
                        <i class="fas ${this.getTeamIcon(team.type)}"></i>
                    </div>
                    <div class="team-card-header-info">
                        <h3>${team.name}</h3>
                        <div class="team-type">${team.type.charAt(0).toUpperCase() + team.type.slice(1)} Response Unit</div>
                    </div>
                    <span class="team-status ${team.status}">${team.status.replace('-', ' ')}</span>
                </div>
                <div class="team-card-body">
                    <div class="team-detail"><i class="fas fa-users"></i><strong>Members:</strong> ${team.members}</div>
                    <div class="team-detail"><i class="fas fa-map-marker-alt"></i><strong>Location:</strong> ${team.location}</div>
                    <div class="team-detail"><i class="fas fa-phone"></i><strong>Contact:</strong> ${team.contact}</div>
                    ${team.vehicle ? `<div class="team-detail"><i class="fas fa-truck-medical"></i><strong>Vehicle:</strong> ${team.vehicle}</div>` : ''}
                </div>
                <div class="team-card-footer">
                    <button class="btn btn-small btn-secondary" onclick="teamManager.editTeam('${team.id}')"><i class="fas fa-edit"></i> Edit</button>
                    ${team.status === 'available' ? `
                    <button class="btn btn-small btn-warning" onclick="teamManager.openAssignModal('${team.id}')"><i class="fas fa-paper-plane"></i> Dispatch</button>
                    ` : team.status === 'on-mission' ? `
                    <button class="btn btn-small btn-primary" onclick="teamManager.completeTeamMission('${team.id}')"><i class="fas fa-check"></i> Complete</button>
                    ` : ''}
                    <button class="btn btn-small btn-danger" onclick="teamManager.deleteTeam('${team.id}')"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `).join('');
    }

    renderTableView() {
        const tbody = document.getElementById('teamsTableBody');
        if (this.teamsCache.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center;padding:40px;color:#7f8c8d;">
                        <i class="fas fa-users-slash" style="font-size:2em;margin-bottom:10px;display:block;"></i>
                        No teams found. Click "Add New Team" to create one.
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = this.teamsCache.map(team => `
            <tr>
                <td><strong>${team.name}</strong></td>
                <td>
                    <i class="fas ${this.getTeamIcon(team.type)}" style="margin-right:8px;color:${this.getTypeColor(team.type)};"></i>
                    ${team.type.charAt(0).toUpperCase() + team.type.slice(1)}
                </td>
                <td><span class="team-status ${team.status}">${team.status.replace('-', ' ')}</span></td>
                <td>${team.members}</td>
                <td>${team.location}</td>
                <td>${team.vehicle || '-'}</td>
                <td class="actions">
                    <button class="btn btn-small btn-secondary" onclick="teamManager.editTeam('${team.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                    ${team.status === 'available' ? `
                    <button class="btn btn-small btn-warning" onclick="teamManager.openAssignModal('${team.id}')" title="Dispatch"><i class="fas fa-paper-plane"></i></button>
                    ` : team.status === 'on-mission' ? `
                    <button class="btn btn-small btn-primary" onclick="teamManager.completeTeamMission('${team.id}')" title="Complete Mission"><i class="fas fa-check"></i></button>
                    ` : ''}
                    <button class="btn btn-small btn-danger" onclick="teamManager.deleteTeam('${team.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                </td>
            </tr>
        `).join('');
    }

    updateStats() {
        const total     = this.teamsCache.length;
        const available = this.teamsCache.filter(t => t.status === 'available').length;
        const onMission = this.teamsCache.filter(t => t.status === 'on-mission').length;
        const standby   = this.teamsCache.filter(t => t.status === 'standby').length;

        document.getElementById('totalTeams').textContent     = total;
        document.getElementById('availableTeams').textContent = available;
        document.getElementById('onMissionTeams').textContent = onMission;
        document.getElementById('standbyTeams').textContent   = standby;
    }

    // ─── CRUD ─────────────────────────────────────────────────────────────────

    async addTeam(teamData) {
        try {
            await addDoc(this.teamCollection, {
                ...teamData,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            alert('Team added successfully!');
            adminLogger.log('create_team', 'Team', null, {
                name: teamData.name, type: teamData.type, status: teamData.status
            });
            return true;
        } catch (error) {
            console.error('Error adding team:', error);
            alert('Error adding team. Please try again.');
            return false;
        }
    }

    async editTeam(teamId) {
        const team = this.teamsCache.find(t => t.id === teamId);
        if (!team) { alert('Team not found!'); return; }

        document.getElementById('editTeamId').value       = teamId;
        document.getElementById('editTeamName').value     = team.name;
        document.getElementById('editTeamType').value     = team.type;
        document.getElementById('editTeamStatus').value   = team.status;
        document.getElementById('editTeamMembers').value  = team.members;
        document.getElementById('editTeamContact').value  = team.contact;
        document.getElementById('editTeamLocation').value = team.location;
        document.getElementById('editTeamVehicle').value  = team.vehicle || '';

        document.getElementById('editTeamModal').style.display = 'block';
    }

    async updateTeam(teamId, teamData) {
        try {
            await updateDoc(doc(firestore, 'Teams', teamId), {
                ...teamData,
                updatedAt: serverTimestamp()
            });
            alert('Team updated successfully!');
            adminLogger.log('update_team', 'Team', teamId, { ...teamData });
            return true;
        } catch (error) {
            console.error('Error updating team:', error);
            alert('Error updating team. Please try again.');
            return false;
        }
    }

    async deleteTeam(teamId) {
        const team = this.teamsCache.find(t => t.id === teamId);
        if (!confirm(`Are you sure you want to delete "${team?.name}"?`)) return;

        try {
            await deleteDoc(doc(firestore, 'Teams', teamId));
            alert('Team deleted successfully!');
            adminLogger.log('delete_team', 'Team', teamId, { name: team?.name });
        } catch (error) {
            console.error('Error deleting team:', error);
            alert('Error deleting team. Please try again.');
        }
    }

    // ─── EMERGENCY LOADING ───────────────────────────────────────────────────

    async loadActiveEmergencies() {
        try {
            const emergencies = [];

            const alertsQuery   = query(this.alertsCollection, where('status', 'in', ['pending', 'dispatched', 'ongoing']), where('isResolved', '==', false));
            const alertsSnapshot = await getDocs(alertsQuery);
            alertsSnapshot.forEach(d => {
                const data = d.data();
                emergencies.push({ id: d.id, type: 'alert', emergencyType: data.type, location: data.location, timestamp: data.timestamp });
            });

            const sosQuery    = query(this.sosCollection, where('status', 'in', ['pending', 'dispatched', 'ongoing']), where('isResolved', '==', false));
            const sosSnapshot = await getDocs(sosQuery);
            sosSnapshot.forEach(d => {
                const data = d.data();
                emergencies.push({ id: d.id, type: 'sos', emergencyType: 'SOS Emergency', location: data.location, timestamp: data.timestamp });
            });

            // Also load active Reports
            const reportsRef  = collection(firestore, 'Reports');
            const reportsQuery = query(reportsRef, where('status', 'in', ['pending', 'dispatched', 'ongoing']), where('isResolved', '==', false));
            const reportsSnap = await getDocs(reportsQuery);
            reportsSnap.forEach(d => {
                const data = d.data();
                emergencies.push({ id: d.id, type: 'report', emergencyType: data.type || 'Emergency Report', location: data.location, timestamp: data.timestamp });
            });

            this.activeEmergencies = emergencies;
            this.updateEmergencySelect();
        } catch (error) {
            console.error('Error loading emergencies:', error);
        }
    }

    updateEmergencySelect() {
        const select = document.getElementById('selectEmergency');
        if (!select) return;

        if (!this.activeEmergencies || this.activeEmergencies.length === 0) {
            select.innerHTML = '<option value="">No active emergencies</option>';
            return;
        }

        select.innerHTML = '<option value="">Select an emergency...</option>' +
            this.activeEmergencies.map(e => `
                <option value="${e.id}" data-type="${e.type}">
                    [${e.type.toUpperCase()}] ${e.emergencyType} - ${e.location}
                </option>
            `).join('');
    }

    // ─── ASSIGN MODAL ────────────────────────────────────────────────────────

    openAssignModal(teamId) {
        const team = this.teamsCache.find(t => t.id === teamId);
        if (!team) { alert('Team not found!'); return; }

        this.loadActiveEmergencies();

        document.getElementById('assignTeamId').value              = teamId;
        document.getElementById('assignTeamName').textContent      = team.name;
        document.getElementById('assignTeamModal').style.display   = 'block';
    }

    // ─── ASSIGN TO EMERGENCY — MAIN FIX ─────────────────────────────────────

    /**
     * Assign a team to an emergency and SMS every team member.
     *
     * Flow:
     *  1. Update team status → on-mission
     *  2. Update the emergency document with assigned team info
     *  3. Fetch full emergency data (citizen name, phone, location, coords)
     *  4. Query Responder collection WHERE respAssignedTeamId == teamId
     *  5. Collect respPhone from each responder
     *  6. Send Mocean SMS to all responders with citizen details
     */
    async assignToEmergency(teamId, emergencyId, emergencyType) {
        try {
            const team = this.teamsCache.find(t => t.id === teamId);
            const collectionName = emergencyType === 'sos' ? 'SOS' : emergencyType === 'report' ? 'Reports' : 'Alerts';
            const emergencyRef   = doc(firestore, collectionName, emergencyId);

            const priorSnap = await getDoc(emergencyRef);
            const prior = priorSnap.exists() ? priorSnap.data() : {};
            const prevTeamId = prior.assignedTeamId || prior.assignedTeam;
            if (prevTeamId && prevTeamId !== teamId) {
                await releasePreviousTeamOnReassign(prevTeamId, emergencyId, 'team_manager');
            }

            // ── 1. Update team status ──────────────────────────────────────
            await updateDoc(doc(firestore, 'Teams', teamId), {
                status:             'on-mission',
                currentMission:     emergencyId,
                missionType:        emergencyType,
                missionStartedAt:   serverTimestamp(),
                updatedAt:          serverTimestamp()
            });

            // ── 2. Update the emergency document ──────────────────────────
            await updateDoc(emergencyRef, {
                assignedTeam:               teamId,
                assignedTeamId:             teamId,
                assignedTeamName:           team?.name || 'Response Team',
                assignedAt:                 serverTimestamp(),
                status:                     'dispatched',
                isResolved:                 false,   // FIX-12a: prevent it from dropping out of isResolved==false queries
            });

            // Also try updating Reports collection (backward compat)
            if (emergencyType !== 'report') {
                try {
                    const reportRef = doc(firestore, 'Reports', emergencyId);
                    const reportDoc = await getDoc(reportRef);
                    if (reportDoc.exists()) {
                        await updateDoc(reportRef, {
                            assignedTeam:           teamId,
                            assignedTeamId:         teamId,
                            assignedTeamName:       team?.name || 'Response Team',
                            assignedAt:             serverTimestamp(),
                            status:                 'dispatched',
                            isResolved:             false,   // FIX-17
                        });
                    }
                } catch (_) { /* fine — report may not exist */ }
            }

            // ── 3. Fetch the full emergency document for citizen details ───
            const emergencySnap = await getDoc(emergencyRef);
            const emergencyData = emergencySnap.exists() ? emergencySnap.data() : {};

            // Normalise citizen details across SOS / Report / Alert
            const citizenData = {
                reportedByName:            emergencyData.reportedByName    || emergencyData.reportedBy    || 'Unknown',
                contactNumber:             emergencyData.contactNumber      || emergencyData.reportedByContactNumber || 'N/A',
                location:                  emergencyData.location           || 'Unknown location',
                coordinates:               emergencyData.coordinates        || null,
                type:                      emergencyData.type               || emergencyType,
                additionalInfo:            emergencyData.additionalInfo     || emergencyData.details || '',
            };

            console.log('[TeamManager] Emergency data for SMS:', citizenData);

            // ── 4. Fetch all responders assigned to this team ──────────────
            const responderPhones = await this._getTeamResponderPhones(teamId, team?.name);

            // FIX-13: Also collect responder emails and write them back to the
            // emergency document as `assignedResponderEmails`. The responder app
            // uses array-contains on this field to scope its onSnapshot query.
            const responderEmails = await this._getTeamResponderEmails(teamId);
            if (responderEmails.length > 0) {
                try {
                    await updateDoc(emergencyRef, {
                        assignedResponderEmails: responderEmails,
                        updatedAt: serverTimestamp(),
                    });
                } catch (_) { /* non-blocking — SMS & dispatch still proceed */ }
            }

            // ── 5. Send SMS to every team member ──────────────────────────
            if (responderPhones.length > 0) {
                console.log(`[TeamManager] Sending dispatch SMS to ${responderPhones.length} responder(s)...`);

                smsService
                    .sendTeamDispatchSMS(citizenData, team, responderPhones)
                    .then(result => {
                        console.log('[TeamManager] Dispatch SMS result:', result);
                        _showDispatchSMSStatus(result);
                    })
                    .catch(err => console.error('[TeamManager] Dispatch SMS error:', err));
            } else {
                console.warn('[TeamManager] No responder phone numbers found for team:', teamId);
                _showDispatchSMSStatus({ success: 0, failed: 0, noPhones: true });
            }

            const cPhone = citizenData.contactNumber;
            if (cPhone && String(cPhone).trim() && cPhone !== 'N/A') {
                const et = (emergencyType || '').toString().toLowerCase();
                const caseType =
                    et === 'sos' ? 'SOS' : et === 'report' ? 'emergency report' : 'emergency';
                notifyCitizenTeamAssigned(cPhone, {
                    teamName: team?.name || 'Response team',
                    caseType,
                    location: citizenData.location || '',
                    refId: emergencyId,
                })
                    .then((r) => console.log('[TeamManager] Citizen team-assigned SMS:', r))
                    .catch((e) => console.error('[TeamManager] Citizen team-assigned SMS error:', e));
            }

            // Log admin action
            adminLogger.log('dispatch_team', 'Team', teamId, { emergencyId, emergencyType });

            alert(`✅ Team "${team?.name}" dispatched successfully!\nSMS notifications are being sent to all team members.`);
            return true;

        } catch (error) {
            console.error('Error assigning team:', error);
            alert('Error dispatching team: ' + error.message);
            return false;
        }
    }

    // ─── HELPER: GET RESPONDER PHONES ────────────────────────────────────────

    /**
     * Fetch all responders in a team and return their phone numbers.
     *
     * Queries the Responder collection where respAssignedTeamId == teamId.
     * Falls back to respAssignedTeamName match for older records.
     *
     * @param {string} teamId
     * @param {string} [teamName]  - Used as fallback query
     * @returns {Promise<string[]>} Array of phone numbers
     * @private
     */
    async _getTeamResponderPhones(teamId, teamName) {
        return getPhonesForTeamDispatch(teamId, teamName);
    }

    // FIX-15: New helper — collect responder emails for assignedResponderEmails field.
    // The responder app's onSnapshot uses array-contains on this field so each
    // responder ONLY receives missions explicitly assigned to their team.
    async _getTeamResponderEmails(teamId) {
        const emails = [];
        try {
            const q = query(
                this.responderCollection,
                where('respAssignedTeamId', '==', teamId)
            );
            const snap = await getDocs(q);
            snap.forEach(d => {
                const email = d.data().respEmail || null;
                if (email && !emails.includes(email)) {
                    emails.push(email.toLowerCase().trim());
                }
            });
            console.log(`[TeamManager] Emails for team ${teamId}:`, emails);
        } catch (error) {
            console.error('[TeamManager] Error fetching responder emails:', error);
        }
        return emails;
    }

    // ─── COMPLETE MISSION ────────────────────────────────────────────────────

    async completeTeamMission(teamId) {
        if (!confirm("Mark this team's mission as complete? They will be available for new assignments.")) return;

        try {
            const teamRef  = doc(firestore, 'Teams', teamId);
            const teamDoc  = await getDoc(teamRef);
            const teamData = teamDoc.data();
            const missionId   = teamData?.currentMission;
            const missionType = teamData?.missionType;

            await updateDoc(teamRef, {
                status:             'available',
                currentMission:     null,
                missionType:        null,
                missionStartedAt:   null,
                missionCompletedAt: serverTimestamp(),
                updatedAt:          serverTimestamp()
            });

            if (missionId && missionType) {
                try {
                    const cName = missionType === 'sos' ? 'SOS' : missionType === 'report' ? 'Reports' : 'Alerts';
                    await updateDoc(doc(firestore, cName, missionId), {
                        status:                     'resolved',
                        isResolved:                 true,
                        resolvedAt:                 serverTimestamp()
                    });
                } catch (e) {
                    console.error('Error updating emergency status:', e);
                }
            }

            alert('Mission completed! Team is now available.');
            adminLogger.log('complete_team_mission', 'Team', teamId);
        } catch (error) {
            console.error('Error completing mission:', error);
            alert('Error completing mission. Please try again.');
        }
    }

    // ─── DEFAULT TEAMS ───────────────────────────────────────────────────────

    renderDefaultTeams() {
        const grid = document.getElementById('defaultTeamsGrid');
        if (!grid) return;

        const iconMap = { police: 'fa-shield-halved', fire: 'fa-fire-extinguisher', medical: 'fa-kit-medical', rescue: 'fa-life-ring' };

        grid.innerHTML = this.defaultTeams.map((team, index) => `
            <div class="default-team-card" data-index="${index}" onclick="teamManager.addDefaultTeam(${index})">
                <div class="team-icon-small ${team.type}">
                    <i class="fas ${iconMap[team.type] || 'fa-users'}"></i>
                </div>
                <div class="team-info-small">
                    <h4>${team.name}</h4>
                    <p>${team.type.charAt(0).toUpperCase() + team.type.slice(1)} • ${team.members} members</p>
                </div>
            </div>
        `).join('');
    }

    updateDefaultTeamsUI() {
        const existingNames = this.teamsCache.map(t => t.name.toLowerCase());
        this.defaultTeams.forEach((team, index) => {
            const card = document.querySelector(`.default-team-card[data-index="${index}"]`);
            if (card) {
                if (existingNames.includes(team.name.toLowerCase())) {
                    card.classList.add('added');
                } else {
                    card.classList.remove('added');
                }
            }
        });
    }

    async addDefaultTeam(index) {
        const template = this.defaultTeams[index];
        const exists = this.teamsCache.some(t => t.name.toLowerCase() === template.name.toLowerCase());
        if (exists) { alert(`"${template.name}" already exists!`); return; }

        const success = await this.addTeam({ ...template, status: 'available' });
        if (success) {
            const card = document.querySelector(`.default-team-card[data-index="${index}"]`);
            if (card) card.classList.add('added');
        }
    }

    async addAllDefaultTeams() {
        const existingNames  = this.teamsCache.map(t => t.name.toLowerCase());
        const teamsToAdd     = this.defaultTeams.filter(t => !existingNames.includes(t.name.toLowerCase()));

        if (teamsToAdd.length === 0) { alert('All default teams have already been added!'); return; }
        if (!confirm(`Add ${teamsToAdd.length} default teams?`)) return;

        let added = 0;
        for (const template of teamsToAdd) {
            try {
                await addDoc(this.teamCollection, { ...template, status: 'available', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
                added++;
            } catch (error) {
                console.error(`Error adding ${template.name}:`, error);
            }
        }
        alert(`Successfully added ${added} teams!`);
    }
}

// ─── SMS STATUS FEEDBACK ──────────────────────────────────────────────────────

/**
 * Show SMS dispatch result in the admin UI.
 * Add <div id="dispatchSMSStatus"></div> anywhere in teams.html to see it.
 */
function _showDispatchSMSStatus(result) {
    const el = document.getElementById('dispatchSMSStatus');
    if (!el) return;

    let msg, color;
    if (result.noPhones) {
        msg   = '⚠️ No phone numbers found for team members. Check responder profiles.';
        color = '#f39c12';
    } else if (result.failed === 0) {
        msg   = `✅ SMS sent to ${result.success} responder(s).`;
        color = '#2ecc71';
    } else {
        msg   = `⚠️ SMS sent to ${result.success}, failed for ${result.failed} responder(s).`;
        color = '#e67e22';
    }

    el.textContent    = msg;
    el.style.color    = color;
    el.style.display  = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

initAdminRealtimeHub();
const teamManager = new TeamManager();
window.teamManager = teamManager;

// ─── GLOBAL UI HANDLERS ───────────────────────────────────────────────────────

window.switchTab = function (tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.closest('.tab-btn').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(tabName + 'View').classList.add('active');
};

window.openAddTeamModal = function () {
    document.getElementById('addTeamForm').reset();
    document.getElementById('addTeamModal').style.display = 'block';
};

window.closeModal = function (modalId) {
    document.getElementById(modalId).style.display = 'none';
};

window.openQuickAddModal = function () {
    const section = document.getElementById('defaultTeamsSection');
    if (section) { section.style.display = 'block'; teamManager.updateDefaultTeamsUI(); }
};

window.closeQuickAdd = function () {
    const section = document.getElementById('defaultTeamsSection');
    if (section) section.style.display = 'none';
};

window.addAllDefaultTeams = function () { teamManager.addAllDefaultTeams(); };

window.handleAddTeam = async function (event) {
    event.preventDefault();
    const teamData = {
        name:     document.getElementById('teamName').value,
        type:     document.getElementById('teamType').value,
        status:   document.getElementById('teamStatus').value,
        members:  parseInt(document.getElementById('teamMembers').value),
        contact:  document.getElementById('teamContact').value,
        location: document.getElementById('teamLocation').value,
        vehicle:  document.getElementById('teamVehicle').value || null
    };
    const success = await teamManager.addTeam(teamData);
    if (success) { closeModal('addTeamModal'); document.getElementById('addTeamForm').reset(); }
};

window.handleEditTeam = async function (event) {
    event.preventDefault();
    const teamId   = document.getElementById('editTeamId').value;
    const teamData = {
        name:     document.getElementById('editTeamName').value,
        type:     document.getElementById('editTeamType').value,
        status:   document.getElementById('editTeamStatus').value,
        members:  parseInt(document.getElementById('editTeamMembers').value),
        contact:  document.getElementById('editTeamContact').value,
        location: document.getElementById('editTeamLocation').value,
        vehicle:  document.getElementById('editTeamVehicle').value || null
    };
    const success = await teamManager.updateTeam(teamId, teamData);
    if (success) closeModal('editTeamModal');
};

window.confirmAssignment = async function () {
    const teamId  = document.getElementById('assignTeamId').value;
    const select  = document.getElementById('selectEmergency');
    const emergencyId = select.value;

    if (!emergencyId) { alert('Please select an emergency to assign.'); return; }

    const emergencyType = select.options[select.selectedIndex].dataset.type;
    const success = await teamManager.assignToEmergency(teamId, emergencyId, emergencyType);
    if (success) closeModal('assignTeamModal');
};

window.filterTeams = function () {
    const typeFilter   = document.getElementById('filterType').value;
    const statusFilter = document.getElementById('filterStatus').value;
    document.querySelectorAll('#teamsTableBody tr').forEach(row => {
        const type   = row.querySelector('td:nth-child(2)')?.textContent.toLowerCase() || '';
        const status = row.querySelector('.team-status')?.textContent.toLowerCase().replace(' ', '-') || '';
        row.style.display = (!typeFilter || type.includes(typeFilter)) && (!statusFilter || status === statusFilter) ? '' : 'none';
    });
};

window.onclick = function (event) {
    if (event.target.classList.contains('modal')) event.target.style.display = 'none';
};

export default TeamManager;