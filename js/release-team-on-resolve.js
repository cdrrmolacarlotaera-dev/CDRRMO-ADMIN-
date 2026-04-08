/**
 * When an emergency (SOS / Report / Alert) is marked resolved, set its assigned team
 * back to available if that team is still on-mission for this incident.
 */
import { firestore, doc, getDoc, updateDoc, serverTimestamp } from './firebase-api.js';
import adminLogger from './admin-logger.js';

export async function releaseAssignedTeamAfterResolve(emergencyId, emergencyData, logSource = 'resolve') {
  const teamId = emergencyData?.assignedTeamId || emergencyData?.assignedTeam;
  if (!teamId || String(teamId).trim() === '') return;

  try {
    const teamRef = doc(firestore, 'Teams', teamId);
    const teamSnap = await getDoc(teamRef);
    if (!teamSnap.exists()) {
      console.warn('[release-team-on-resolve] team doc not found:', teamId);
      return;
    }

    const t = teamSnap.data();
    const currentMission = t.currentMission;

    if (
      currentMission != null &&
      String(currentMission) !== String(emergencyId)
    ) {
      console.warn(
        '[release-team-on-resolve] team',
        teamId,
        'on different mission; skip release.',
        currentMission
      );
      return;
    }

    await updateDoc(teamRef, {
      status: 'available',
      availability: 'Available',
      currentMission: null,
      missionType: null,
      missionLocation: null,
      missionCoordinates: null,
      missionStartedAt: null,
      missionCompletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    console.log('[release-team-on-resolve] team', teamId, 'available again; emergency', emergencyId);
    adminLogger.log('team_released_on_resolve', 'Team', teamId, {
      emergencyId,
      source: logSource,
    });
  } catch (e) {
    console.error('[release-team-on-resolve]', e);
  }
}

/**
 * When an emergency is reassigned to another team, clear the previous team’s on-mission
 * state if they were still tied to this incident (or had no currentMission set).
 * Skips if that team is booked on a different incident.
 */
export async function releasePreviousTeamOnReassign(previousTeamId, emergencyId, logSource = 'reassign') {
  if (!previousTeamId || String(previousTeamId).trim() === '') return;

  try {
    const teamRef = doc(firestore, 'Teams', previousTeamId);
    const teamSnap = await getDoc(teamRef);
    if (!teamSnap.exists()) {
      console.warn('[release-team-on-reassign] team doc not found:', previousTeamId);
      return;
    }

    const t = teamSnap.data();
    const mission = t.currentMission;

    if (mission != null && String(mission) !== String(emergencyId)) {
      console.warn(
        '[release-team-on-reassign] team',
        previousTeamId,
        'on different mission; skip release.',
        mission
      );
      return;
    }

    await updateDoc(teamRef, {
      status: 'available',
      availability: 'Available',
      currentMission: null,
      missionType: null,
      missionLocation: null,
      missionCoordinates: null,
      missionStartedAt: null,
      missionCompletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    console.log('[release-team-on-reassign] released', previousTeamId, 'from emergency', emergencyId);
    adminLogger.log('team_released_on_reassign', 'Team', previousTeamId, {
      emergencyId,
      source: logSource,
    });
  } catch (e) {
    console.error('[release-team-on-reassign]', e);
  }
}
