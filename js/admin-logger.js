import {
  firestore,
  collection,
  addDoc,
  serverTimestamp
} from './firebase-api.js';

class AdminLogger {
  async log(action, targetType, targetId = null, details = {}) {
    try {
      const logsRef = collection(firestore, 'SystemLogs');
      await addDoc(logsRef, {
        action,
        targetType,
        targetId,
        details,
        performedBy: 'admin_panel',
        createdAt: serverTimestamp()
      });
    } catch (error) {
      console.error('Error writing admin log:', error);
    }
  }
}

const adminLogger = new AdminLogger();

export default adminLogger;

