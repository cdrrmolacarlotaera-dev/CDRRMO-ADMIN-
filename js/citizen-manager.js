import { 
  firestore,
  collection,
  getDocs,
  getDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  onSnapshot,
  orderBy
} from './firebase-api.js';
import adminLogger from './admin-logger.js';

/**
 * CitizenManager - Handles displaying, approving, and managing citizens
 */
class CitizenManager {
  constructor() {
    // Initialize Firebase references
    this.citizenCollection = collection(firestore, 'Citizen');
    
    // DOM element references
    this.pendingUsersModal = document.getElementById('pendingUsersModal');
    this.pendingUsersList = document.querySelector('.pending-user-list');
    this.pendingCountSpan = document.getElementById('pending-count');
    this.citizenTable = document.querySelector('.user-table tbody');
    this.acceptAllButton = document.querySelector('.accept-all-button');
    this.searchInput = document.getElementById('searchInput');
    this.paginationControls = document.getElementById('paginationControls');

    // Data caches and pagination state
    this.allCitizens = [];
    this.filteredCitizens = [];
    this.currentPage = 1;
    this.rowsPerPage = 5;
    
    // Add reject all button if it doesn't exist
    if (!document.querySelector('.reject-all-button')) {
      const rejectAllButton = document.createElement('button');
      rejectAllButton.className = 'reject-all-button';
      rejectAllButton.textContent = 'Reject All';
      rejectAllButton.style.backgroundColor = '#e74c3c';
      rejectAllButton.style.color = '#fff';
      
      const modalActions = document.querySelector('.modal-actions');
      modalActions.appendChild(rejectAllButton);
      this.rejectAllButton = rejectAllButton;
    } else {
      this.rejectAllButton = document.querySelector('.reject-all-button');
    }
    
    // Add reference to edit modal
    this.editUserModal = document.getElementById('editUserModal');
    if (!this.editUserModal) {
      this.createEditModal();
    }
    
    // Add CSS for the user details in the modal
    this.addCustomStyles();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Load data
    this.loadAllCitizens();
    this.loadPendingCitizens();
  }
  
  /**
   * Create the edit modal if it doesn't exist
   */
  createEditModal() {
    const modal = document.createElement('div');
    modal.id = 'editUserModal';
    modal.className = 'modal';
    
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Edit Citizen</h2>
          <span class="close-button">&times;</span>
        </div>
        <div class="modal-body">
          <form id="editCitizenForm">
            <input type="hidden" id="editCitizenId">
            
            <div class="form-group">
              <label for="editName">Name:</label>
              <input type="text" id="editName" required>
            </div>
            
            <div class="form-group">
              <label for="editEmail">Email:</label>
              <input type="email" id="editEmail" required>
            </div>
            
            <div class="form-group">
              <label for="editAddress">Address:</label>
              <textarea id="editAddress" required></textarea>
            </div>
            
            <div class="form-group">
              <label for="editContact">Contact Number:</label>
              <input type="text" id="editContact" required>
            </div>
            
            <div class="form-group">
              <label for="editStatus">Status:</label>
              <select id="editStatus" required>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
            
            <div class="form-group">
              <label>Reset Password:</label>
              <div style="display: flex; gap: 8px; align-items: center;">
                <input type="text" id="editNewPassword" placeholder="New password" style="flex: 1;">
                <button type="button" id="generateCitizenPasswordBtn" style="background: #3498db; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; white-space: nowrap;">
                  <i class="fas fa-key"></i> Generate
                </button>
              </div>
              <small style="color: #7f8c8d;">Leave empty to keep current password</small>
            </div>
            
            <div class="form-group" id="idProofContainer">
              <label>ID Proof:</label>
              <div class="id-proof-preview">
                <img id="editIdProof" src="" alt="ID Proof" style="max-width: 200px; max-height: 200px; display: none;">
                <p id="noIdProofMessage">No ID proof provided</p>
              </div>
            </div>
            
            <div class="form-actions">
              <button type="submit" class="save-button">Save Changes</button>
              <button type="button" class="cancel-button">Cancel</button>
            </div>
          </form>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    this.editUserModal = modal;
    
    // Add event listeners for the modal
    const closeButton = modal.querySelector('.close-button');
    closeButton.addEventListener('click', () => {
      modal.style.display = 'none';
    });
    
    const cancelButton = modal.querySelector('.cancel-button');
    cancelButton.addEventListener('click', () => {
      modal.style.display = 'none';
    });
    
    const form = modal.querySelector('#editCitizenForm');
    form.addEventListener('submit', (e) => this.handleEditFormSubmit(e));
    // Password generate button
    const genPwdBtn = modal.querySelector('#generateCitizenPasswordBtn');
    if (genPwdBtn) {
      genPwdBtn.addEventListener('click', () => {
        const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
        let pwd = '';
        for (let i = 0; i < 10; i++) {
          pwd += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        document.getElementById('editNewPassword').value = pwd;
      });
    }
  }
  
  /**
   * Add custom styles for displaying citizen details and edit modal
   */
  addCustomStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .user-details {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        width: 100%;
      }
      
      .user-info {
        flex: 1;
      }
      
      .id-proof {
        margin-left: 20px;
        text-align: center;
      }
      
      .id-proof img {
        cursor: pointer;
        transition: transform 0.3s ease;
        border: 1px solid #ddd;
      }
      
      .id-proof img:hover {
        transform: scale(1.1);
        box-shadow: 0 4px 8px rgba(0,0,0,0.2);
      }
      
      .reject-all-button {
        background-color: #e74c3c;
        color: #fff;
        padding: 10px 15px;
        margin-left: 10px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 1em;
      }
      
      .reject-all-button:hover {
        background-color: #c0392b;
      }
      
      /* Verification badges */
      .badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 0.85em;
        font-weight: bold;
      }
      
      .badge-resident {
        background-color: #d4edda;
        color: #155724;
        border: 1px solid #c3e6cb;
      }
      
      .badge-outsider {
        background-color: #fff3cd;
        color: #856404;
        border: 1px solid #ffeeba;
      }
      
      .verification-status {
        margin-top: 8px;
      }
      
      /* Pending notification badge animation */
      @keyframes pulse {
        0% { transform: scale(1); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }
      
      .notification-badge {
        background-color: #e74c3c;
        color: white;
        border-radius: 50%;
        padding: 2px 8px;
        font-size: 0.8em;
        animation: pulse 2s infinite;
      }
      
      /* Edit modal styles */
      #editUserModal .modal-content {
        max-width: 600px;
      }
      
      #editUserModal .form-group {
        margin-bottom: 15px;
      }
      
      #editUserModal label {
        display: block;
        margin-bottom: 5px;
        font-weight: bold;
      }
      
      #editUserModal input, 
      #editUserModal textarea, 
      #editUserModal select {
        width: 100%;
        padding: 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 14px;
      }
      
      #editUserModal textarea {
        height: 80px;
        resize: vertical;
      }
      
      #editUserModal .id-proof-preview {
        margin-top: 10px;
        border: 1px solid #ddd;
        padding: 10px;
        border-radius: 4px;
        background-color: #f9f9f9;
        text-align: center;
      }
      
      #editUserModal .save-button {
        background-color: #2ecc71;
        color: white;
        border: none;
        padding: 10px 15px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 1em;
      }
      
      #editUserModal .save-button:hover {
        background-color: #27ae60;
      }
    `;
    document.head.appendChild(style);
  }
  
  /**
   * Set up all event listeners
   */
  setupEventListeners() {
    // Accept all button
    this.acceptAllButton.addEventListener('click', () => this.acceptAllCitizens());
    
    // Reject all button
    this.rejectAllButton.addEventListener('click', () => this.rejectAllCitizens());
    
    // Event delegation for accept/reject buttons in the modal
    this.pendingUsersList.addEventListener('click', (e) => {
      const listItem = e.target.closest('li');
      if (!listItem) return;
      
      const citizenId = listItem.dataset.userId;
      
      if (e.target.classList.contains('accept-button')) {
        this.acceptCitizen(citizenId);
      } else if (e.target.classList.contains('reject-button')) {
        this.rejectCitizen(citizenId);
      }
    });
    
    // Update event delegation for edit/delete buttons in the main table
    this.citizenTable.addEventListener('click', async (e) => {
      const row = e.target.closest('tr');
      if (!row) return;
      
      const citizenId = row.dataset.userId;
      
      if (e.target.classList.contains('edit-button')) {
        this.openEditModal(citizenId);
      } else if (e.target.classList.contains('delete-button')) {
        this.confirmAndDeleteCitizen(citizenId);
      }
    });

    // Search bar integration
    if (this.searchInput) {
      this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
    }
  }
  
  /**
   * Set up real-time listener for all citizens
   */
  loadAllCitizens() {
    const q = query(this.citizenCollection, where('citiStatus', '==', 'approved'), orderBy('citiName', 'asc'));
    
    onSnapshot(q, (snapshot) => {
      this.allCitizens = [];
      snapshot.forEach(doc => {
        const citizen = doc.data();
        citizen.id = doc.id;
        this.allCitizens.push(citizen);
      });
      // Delegate to handleSearch the first time to sync rendering and pagination
      this.handleSearch(this.searchInput ? this.searchInput.value : '');
    }, (error) => {
      console.error("Error getting citizens:", error);
      alert("Error loading citizens. Please check your connection.");
    });
  }
  
  /**
   * Set up real-time listener for pending citizens
   */
  loadPendingCitizens() {
    const q = query(this.citizenCollection, where('citiStatus', '==', 'pending'));
    
    onSnapshot(q, (snapshot) => {
      // Clear the pending list first
      this.pendingUsersList.innerHTML = '';
      
      // Update the pending count
      const pendingCount = snapshot.size;
      this.pendingCountSpan.textContent = pendingCount;
      
      if (snapshot.empty) {
        const emptyItem = document.createElement('li');
        emptyItem.textContent = 'No pending citizens found';
        this.pendingUsersList.appendChild(emptyItem);
        this.acceptAllButton.style.display = 'none';
        this.rejectAllButton.style.display = 'none';
        return;
      }
      
      // Show the accept/reject all buttons
      this.acceptAllButton.style.display = 'inline-block';
      this.rejectAllButton.style.display = 'inline-block';
      
      // Add each pending citizen to the list
      snapshot.forEach(doc => {
        const citizen = doc.data();
        this.addPendingCitizenToList(doc.id, citizen);
      });
    }, (error) => {
      console.error("Error getting pending citizens:", error);
      alert("Error loading pending citizens. Please check your connection.");
    });
  }
  
  /**
   * Add a citizen to the main table
   */
  addCitizenToTable(citizenId, citizen) {
    const row = document.createElement('tr');
    row.dataset.userId = citizenId;
    
    row.innerHTML = `
      <td>${citizen.citiID || citizenId.substring(0, 8)}</td>
      <td>${citizen.citiName || 'N/A'}</td>
      <td>${citizen.email || 'N/A'}</td>
      <td>${citizen.citiAddress || 'N/A'}</td>
      <td>${citizen.citiContactNumber || 'N/A'}</td>
      <td>
        <button class="edit-button">Edit</button>
        <button class="delete-button">Delete</button>
      </td>
    `;
    
    this.citizenTable.appendChild(row);
  }

  /**
   * Search and Pagination handlers
   */
  handleSearch(searchValue) {
    if (!searchValue) {
      this.filteredCitizens = [...this.allCitizens];
    } else {
      this.filteredCitizens = this.allCitizens.filter(citizen => {
        // Create an indexable clone omitting the ID or keeping it stringified
        return Object.values(citizen).some(val => 
          String(val).toLowerCase().includes(searchValue.toLowerCase())
        );
      });
    }
    this.currentPage = 1;
    this.renderTable();
  }

  renderTable() {
    this.citizenTable.innerHTML = '';
    
    if (this.filteredCitizens.length === 0) {
      const emptyRow = document.createElement('tr');
      emptyRow.innerHTML = '<td colspan="6" style="text-align: center;">No citizens found</td>';
      this.citizenTable.appendChild(emptyRow);
      this.renderPagination();
      return;
    }
    
    // Calculate chunk
    const start = (this.currentPage - 1) * this.rowsPerPage;
    const paginated = this.filteredCitizens.slice(start, start + this.rowsPerPage);
    
    // Render current slice
    paginated.forEach(citizen => {
      this.addCitizenToTable(citizen.id, citizen);
    });
    
    this.renderPagination();
  }

  renderPagination() {
    if (!this.paginationControls) return;
    this.paginationControls.innerHTML = '';
    
    const totalPages = Math.ceil(this.filteredCitizens.length / this.rowsPerPage);
    if (totalPages <= 1) return;
    
    // Prev
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pagination-button';
    prevBtn.innerHTML = '&laquo;';
    prevBtn.disabled = this.currentPage === 1;
    prevBtn.onclick = () => this.goToPage(this.currentPage - 1);
    this.paginationControls.appendChild(prevBtn);
    
    // Numbers
    for (let i = 1; i <= totalPages; i++) {
      const btn = document.createElement('button');
      btn.className = `pagination-button ${i === this.currentPage ? 'active' : ''}`;
      btn.textContent = i;
      btn.onclick = () => this.goToPage(i);
      this.paginationControls.appendChild(btn);
    }
    
    // Next
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-button';
    nextBtn.innerHTML = '&raquo;';
    nextBtn.disabled = this.currentPage === totalPages;
    nextBtn.onclick = () => this.goToPage(this.currentPage + 1);
    this.paginationControls.appendChild(nextBtn);
  }

  goToPage(page) {
    const totalPages = Math.ceil(this.filteredCitizens.length / this.rowsPerPage);
    if (page >= 1 && page <= Math.max(1, totalPages)) {
      this.currentPage = page;
      this.renderTable();
    }
  }
  
  /**
   * Add a pending citizen to the modal list
   */
  addPendingCitizenToList(citizenId, citizen) {
    const listItem = document.createElement('li');
    listItem.dataset.userId = citizenId;
    
    // Determine residency status badge
    const isResident = citizen.citiIsLaCarlotaResident;
    const verificationScore = citizen.citiVerificationScore || 0;
    const residencyBadge = isResident 
      ? `<span class="badge badge-resident"><i class="fas fa-check-circle"></i> La Carlota Resident (${verificationScore}%)</span>`
      : `<span class="badge badge-outsider"><i class="fas fa-exclamation-triangle"></i> Non-Resident / Manual Review Required</span>`;
    
    // Create HTML with name, email, address, verification info, and ID proof image
    listItem.innerHTML = `
      <div class="user-details">
        <div class="user-info">
          <span><strong>Name:</strong> ${citizen.citiName || 'N/A'}</span><br>
          <span><strong>Email:</strong> ${citizen.email || 'N/A'}</span><br>
          <span><strong>Address:</strong> ${citizen.citiAddress || 'N/A'}</span><br>
          <span><strong>Contact:</strong> ${citizen.citiContactNumber || 'N/A'}</span><br>
          <div class="verification-status" style="margin-top: 8px;">
            ${residencyBadge}
          </div>
        </div>
        ${(citizen.citiIdProofUrl || citizen.citiImageURL) ? `
          <div class="id-proof">
            <span><strong>ID Proof:</strong></span><br>
            <img src="${citizen.citiIdProofUrl || citizen.citiImageURL}" alt="ID Proof" style="max-width: 100px; max-height: 100px; margin-top: 5px; border-radius: 4px; cursor: pointer;" onclick="window.open('${citizen.citiIdProofUrl || citizen.citiImageURL}', '_blank')">
            <br><small style="color: #7f8c8d;">Click to view full size</small>
            ${citizen.citiVerificationStatus ? `<br><small><strong>Verification:</strong> ${citizen.citiVerificationStatus}</small>` : ''}
          </div>
        ` : '<div class="id-proof"><span style="color: #e74c3c;"><i class="fas fa-times-circle"></i> No ID provided</span></div>'}
      </div>
      <div class="user-actions-modal">
        <button class="accept-button"><i class="fas fa-check"></i> Accept</button>
        <button class="reject-button"><i class="fas fa-times"></i> Reject</button>
      </div>
    `;
    
    this.pendingUsersList.appendChild(listItem);
  }
  
  /**
   * Accept a single citizen
   */
  async acceptCitizen(citizenId) {
    try {
      const citizenRef = doc(firestore, 'Citizen', citizenId);
      await updateDoc(citizenRef, {
        citiStatus: 'approved',
        citiVerificationStatus: 'verified'
      });
      console.log(`Citizen ${citizenId} approved successfully`);
      
      adminLogger.log('approve_citizen', 'Citizen', citizenId);
    } catch (error) {
      console.error("Error approving citizen:", error);
      alert("Error approving citizen. Please try again.");
    }
  }
  
  /**
   * Reject a single citizen
   */
  async rejectCitizen(citizenId) {
    try {
      const citizenRef = doc(firestore, 'Citizen', citizenId);
      await updateDoc(citizenRef, {
        citiStatus: 'rejected',
        citiVerificationStatus: 'rejected'
      });
      console.log(`Citizen ${citizenId} rejected successfully`);
      
      adminLogger.log('reject_citizen', 'Citizen', citizenId);
    } catch (error) {
      console.error("Error rejecting citizen:", error);
      alert("Error rejecting citizen. Please try again.");
    }
  }
  
  /**
   * Accept all pending citizens
   */
  async acceptAllCitizens() {
    if (!confirm('Are you sure you want to approve all pending citizens?')) {
      return;
    }
    
    try {
      const q = query(this.citizenCollection, where('citiStatus', '==', 'pending'));
      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        alert('No pending citizens to approve');
        return;
      }
      
      const promises = [];
      snapshot.forEach(doc => {
        const citizenRef = doc.ref;
        promises.push(updateDoc(citizenRef, { citiStatus: 'approved', citiVerificationStatus: 'verified' }));
      });
      
      await Promise.all(promises);
      console.log(`${promises.length} citizens approved successfully`);
      alert(`${promises.length} citizens approved successfully`);
      
      // Log admin action
      adminLogger.log('bulk_approve_citizens', 'Citizen', null, {
        count: promises.length
      });
      
      // Close the modal
      this.pendingUsersModal.style.display = 'none';
    } catch (error) {
      console.error("Error approving all citizens:", error);
      alert("Error approving all citizens. Please try again.");
    }
  }
  
  /**
   * Reject all pending citizens
   */
  async rejectAllCitizens() {
    if (!confirm('Are you sure you want to reject all pending citizens?')) {
      return;
    }
    
    try {
      const q = query(this.citizenCollection, where('citiStatus', '==', 'pending'));
      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        alert('No pending citizens to reject');
        return;
      }
      
      const promises = [];
      snapshot.forEach(doc => {
        const citizenRef = doc.ref;
        promises.push(updateDoc(citizenRef, { citiStatus: 'rejected', citiVerificationStatus: 'rejected' }));
      });
      
      await Promise.all(promises);
      console.log(`${promises.length} citizens rejected successfully`);
      alert(`${promises.length} citizens rejected successfully`);
      
      // Log admin action
      adminLogger.log('bulk_reject_citizens', 'Citizen', null, {
        count: promises.length
      });
      
      // Close the modal
      this.pendingUsersModal.style.display = 'none';
    } catch (error) {
      console.error("Error rejecting all citizens:", error);
      alert("Error rejecting all citizens. Please try again.");
    }
  }
  
  /**
   * Delete a citizen
   */
  async deleteCitizen(citizenId) {
    try {
      const citizenRef = doc(firestore, 'Citizen', citizenId);
      await deleteDoc(citizenRef);
      console.log(`Citizen ${citizenId} deleted successfully`);
      
      // Log admin action
      adminLogger.log('delete_citizen', 'Citizen', citizenId);
    } catch (error) {
      console.error("Error deleting citizen:", error);
      alert("Error deleting citizen. Please try again.");
    }
  }
  
  /**
   * Open the edit modal and populate with citizen data
   */
  async openEditModal(citizenId) {
    try {
      // Get citizen data
      const citizenRef = doc(firestore, 'Citizen', citizenId);
      const citizenSnap = await getDoc(citizenRef);
      
      if (!citizenSnap.exists()) {
        alert('Citizen not found!');
        return;
      }
      
      const citizen = citizenSnap.data();
      
      // Populate form fields
      document.getElementById('editCitizenId').value = citizenId;
      document.getElementById('editName').value = citizen.citiName || '';
      document.getElementById('editEmail').value = citizen.email || '';
      document.getElementById('editAddress').value = citizen.citiAddress || '';
      document.getElementById('editContact').value = citizen.citiContactNumber || '';
      document.getElementById('editStatus').value = citizen.citiStatus || 'pending';
      // Clear password field
      const pwdField = document.getElementById('editNewPassword');
      if (pwdField) pwdField.value = '';
      
      // Display ID proof if available
      const idProofImg = document.getElementById('editIdProof');
      const noIdProofMessage = document.getElementById('noIdProofMessage');
      
      const idProofSrc = citizen.citiIdProofUrl || citizen.citiImageURL;
      if (idProofSrc) {
        idProofImg.src = idProofSrc;
        idProofImg.style.display = 'block';
        idProofImg.style.cursor = 'pointer';
        idProofImg.onclick = () => window.open(idProofSrc, '_blank');
        noIdProofMessage.style.display = 'none';
      } else {
        idProofImg.style.display = 'none';
        noIdProofMessage.style.display = 'block';
      }
      
      // Show the modal
      this.editUserModal.style.display = 'block';
    } catch (error) {
      console.error("Error loading citizen data:", error);
      alert("Error loading citizen data. Please try again.");
    }
  }
  
  /**
   * Handle the edit form submission
   */
  async handleEditFormSubmit(e) {
    e.preventDefault();
    
    try {
      const citizenId = document.getElementById('editCitizenId').value;
      
      // Gather form data
      const updatedData = {
        citiName: document.getElementById('editName').value,
        email: document.getElementById('editEmail').value,
        citiAddress: document.getElementById('editAddress').value,
        citiContactNumber: document.getElementById('editContact').value,
        citiStatus: document.getElementById('editStatus').value
      };
      // Include new password if provided (Issue 4 fix)
      const newPassword = document.getElementById('editNewPassword')?.value?.trim();
      if (newPassword) {
        updatedData.citiPassword = newPassword;
      }
      
      // Update in Firestore
      const citizenRef = doc(firestore, 'Citizen', citizenId);
      await updateDoc(citizenRef, updatedData);
      
      // Close the modal
      this.editUserModal.style.display = 'none';
      
      alert('Citizen updated successfully!');
      
      // Log admin action
      adminLogger.log('update_citizen', 'Citizen', citizenId, {
        ...updatedData
      });
    } catch (error) {
      console.error("Error updating citizen:", error);
      alert("Error updating citizen. Please try again.");
    }
  }
  
  /**
   * Confirm and delete a citizen
   */
  async confirmAndDeleteCitizen(citizenId) {
    try {
      // Get citizen name for confirmation
      const citizenRef = doc(firestore, 'Citizen', citizenId);
      const citizenSnap = await getDoc(citizenRef);
      
      if (!citizenSnap.exists()) {
        alert('Citizen not found!');
        return;
      }
      
      const citizen = citizenSnap.data();
      const citizenName = citizen.citiName || 'this citizen';
      
      // Confirm deletion
      if (confirm(`Are you sure you want to delete ${citizenName}? This cannot be undone.`)) {
        await deleteDoc(citizenRef);
        alert(`${citizenName} has been deleted successfully.`);
      }
    } catch (error) {
      console.error("Error deleting citizen:", error);
      alert("Error deleting citizen. Please try again.");
    }
  }
}

// Initialize the manager when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new CitizenManager();
});

export default CitizenManager;