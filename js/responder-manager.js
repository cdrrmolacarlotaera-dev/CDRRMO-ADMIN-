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
import { initAdminRealtimeHub } from './admin-notifications.js';

/**
 * ResponderManager: Manages CRUD operations for responders with real-time updates
 */
class ResponderManager {
    constructor() {
        // Initialize references
        this.responderCollection = collection(firestore, 'Responder');
        this.teamsCollection = collection(firestore, 'Teams');
        
        // Cache for teams
        this.teamsCache = [];
        
        // Cache DOM elements
        this.form = document.getElementById('responderForm');
        this.responderTable = document.querySelector('.user-table tbody');
        this.departmentSelect = document.getElementById('department');
        this.assignedTeamSelect = document.getElementById('assignedTeam');
        this.firstNameInput = document.getElementById('firstName');
        this.lastNameInput = document.getElementById('lastName');
        this.emailInput = document.getElementById('email');
        this.usernameDisplay = document.getElementById('generatedUsername');
        this.passwordDisplay = document.getElementById('generatedPassword');
        this.addUserModal = document.getElementById('addUserModal');
        
        // Create edit modal if it doesn't exist
        this.createEditModal();
        
        this.searchInput = document.getElementById('searchInput');
        this.paginationControls = document.getElementById('paginationControls');
        
        this.allResponders = [];
        this.filteredResponders = [];
        this.currentPage = 1;
        this.rowsPerPage = 5;
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Load responders with real-time updates
        this.setupRealtimeListener();
        
        // Load teams from Firebase
        this.loadTeamsFromFirebase();
    }
    
    /**
     * Load teams from Firebase Teams collection
     */
    loadTeamsFromFirebase() {
        const q = query(this.teamsCollection, orderBy('name', 'asc'));
        
        onSnapshot(q, (snapshot) => {
            this.teamsCache = [];
            snapshot.forEach(doc => {
                this.teamsCache.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            
            // Update team dropdowns
            this.updateTeamDropdowns();
        }, (error) => {
            console.error("Error loading teams:", error);
        });
    }
    
    /**
     * Update team dropdown with teams from Firebase
     */
    updateTeamDropdowns() {
        // Update main form dropdown
        if (this.assignedTeamSelect) {
            const currentValue = this.assignedTeamSelect.value;
            this.assignedTeamSelect.innerHTML = '<option value="">No Team Assignment (Optional)</option>';
            
            // Group teams by type
            const teamsByType = {};
            this.teamsCache.forEach(team => {
                if (!teamsByType[team.type]) {
                    teamsByType[team.type] = [];
                }
                teamsByType[team.type].push(team);
            });
            
            // Create optgroups
            Object.keys(teamsByType).sort().forEach(type => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = type.charAt(0).toUpperCase() + type.slice(1) + ' Teams';
                
                teamsByType[type].forEach(team => {
                    const option = document.createElement('option');
                    option.value = team.id;
                    option.textContent = `${team.name} (${team.status})`;
                    option.dataset.teamName = team.name;
                    option.dataset.teamType = team.type;
                    if (team.status !== 'available') {
                        option.style.color = '#999';
                    }
                    optgroup.appendChild(option);
                });
                
                this.assignedTeamSelect.appendChild(optgroup);
            });
            
            // Restore selection if possible
            if (currentValue) {
                this.assignedTeamSelect.value = currentValue;
            }
        }
        
        // Update edit form dropdown if it exists
        const editTeamSelect = document.getElementById('editAssignedTeam');
        if (editTeamSelect) {
            const currentEditValue = editTeamSelect.value;
            editTeamSelect.innerHTML = '<option value="">No Team Assignment</option>';
            
            this.teamsCache.forEach(team => {
                const option = document.createElement('option');
                option.value = team.id;
                option.textContent = `${team.name} (${team.type} - ${team.status})`;
                editTeamSelect.appendChild(option);
            });
            
            if (currentEditValue) {
                editTeamSelect.value = currentEditValue;
            }
        }
    }
    
    /**
     * Set up all event listeners
     */
    setupEventListeners() {
        // Form submission
        this.form.addEventListener('submit', (e) => this.handleFormSubmit(e));
        
        // Generate credentials when inputs change
        this.firstNameInput.addEventListener('input', () => this.generateCredentials());
        this.lastNameInput.addEventListener('input', () => this.generateCredentials());
        this.departmentSelect.addEventListener('change', () => this.generateCredentials());
        
        // Filter teams when department changes
        this.departmentSelect.addEventListener('change', () => this.filterTeamsByDepartment());
        
        // Delete responder
        this.responderTable.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-button')) {
                const row = e.target.closest('tr');
                const respId = row.dataset.id;
                this.deleteResponder(respId);
            }
        });
        
        // Edit responder status
        this.responderTable.addEventListener('click', (e) => {
            if (e.target.classList.contains('edit-button')) {
                const row = e.target.closest('tr');
                const respId = row.dataset.id;
                this.openEditModal(respId);
            }
        });

        // Event delegation for edit/delete buttons in the main table
        this.responderTable.addEventListener('click', (e) => {
            const row = e.target.closest('tr');
            if (!row) return;
            
            const respId = row.dataset.id;
            
            if (e.target.classList.contains('edit-button')) {
              this.openEditModal(respId);
            } else if (e.target.classList.contains('delete-button')) {
              if (confirm('Are you sure you want to delete this responder?')) {
                this.deleteResponder(respId);
              }
            }
        });
        
        // Add this event listener for toggle status button
        this.responderTable.addEventListener('click', (e) => {
            if (e.target.classList.contains('toggle-status-button') || 
                (e.target.parentElement && e.target.parentElement.classList.contains('toggle-status-button'))) {
                const row = e.target.closest('tr');
                const respId = row.dataset.id;
                this.toggleResponderStatus(respId);
            }
        });

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }
    }
    
    /**
     * Create a real-time listener for responders
     */
    setupRealtimeListener() {
        const q = query(this.responderCollection, orderBy('respID', 'asc'));
        
        onSnapshot(q, (snapshot) => {
            this.allResponders = [];
            
            snapshot.forEach(doc => {
                const data = doc.data();
                data.id = doc.id;
                this.allResponders.push(data);
            });
            
            // Fix Issue 9: Update stats cards
            this.updateStats(snapshot);
            
            // Initial render with search & pagination
            this.handleSearch(this.searchInput ? this.searchInput.value : '');
        }, (error) => {
            console.error("Error getting responders:", error);
            alert("Error loading responders. Please check your connection.");
        });
    }
    
    /**
     * Filter teams dropdown based on selected department
     */
    filterTeamsByDepartment() {
        const department = this.departmentSelect.value.toLowerCase();
        
        if (!this.assignedTeamSelect) return;
        
        // Reset dropdown
        this.assignedTeamSelect.innerHTML = '<option value="">No Team Assignment (Optional)</option>';
        
        // Map department to team type
        const typeMap = {
            'fire': 'fire',
            'medical': 'medical',
            'rescue': 'rescue',
            'police': 'police',
            'flood': 'rescue', // Flood falls under rescue
            'other': null // Show all teams
        };
        
        const targetType = typeMap[department];
        
        // Filter and add teams
        const filteredTeams = targetType === null 
            ? this.teamsCache 
            : this.teamsCache.filter(team => team.type === targetType);
        
        if (filteredTeams.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = `No ${department} teams available - Create one in Teams page`;
            option.disabled = true;
            this.assignedTeamSelect.appendChild(option);
            return;
        }
        
        filteredTeams.forEach(team => {
            const option = document.createElement('option');
            option.value = team.id;
            option.textContent = `${team.name} (${team.status})`;
            option.dataset.teamName = team.name;
            option.dataset.teamType = team.type;
            if (team.status !== 'available') {
                option.style.color = '#999';
            }
            this.assignedTeamSelect.appendChild(option);
        });
    }
    
    /**
     * Add a responder to the table
     */
    addResponderToTable(docId, data) {
        const row = document.createElement('tr');
        row.dataset.id = docId;
        
        // Get team name from cache or use stored name
        let teamDisplay = data.respAssignedTeamName || data.respTeam || 'Unassigned';
        
        row.innerHTML = `
            <td>${data.respID}</td>
            <td>${data.respUsername}</td>
            <td>${data.respFirstName} ${data.respLastName}</td>
            <td>${data.respDepartment}</td>
            <td>${teamDisplay}</td>
            <td><span class="status-${data.respIsActive ? 'active' : 'inactive'}">${data.respIsActive ? 'Active' : 'Inactive'}</span></td>
            <td>
                <button class="toggle-status-button" title="${data.respIsActive ? 'Set to Inactive' : 'Set to Active'}">
                    <i class="fas ${data.respIsActive ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                </button>
                <button class="edit-button">Edit</button>
                <button class="delete-button">Delete</button>
            </td>
        `;
        
        this.responderTable.appendChild(row);
    }
    
    /**
     * Search and Pagination handlers
     */
    handleSearch(searchValue) {
        if (!searchValue) {
            this.filteredResponders = [...this.allResponders];
        } else {
            this.filteredResponders = this.allResponders.filter(responder => {
                return Object.values(responder).some(val => 
                    String(val).toLowerCase().includes(searchValue.toLowerCase())
                );
            });
        }
        this.currentPage = 1;
        this.renderTable();
    }
    
    renderTable() {
        this.responderTable.innerHTML = '';
        
        if (this.filteredResponders.length === 0) {
            const emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="7" style="text-align: center;">No responders found</td>';
            this.responderTable.appendChild(emptyRow);
            this.renderPagination();
            return;
        }
        
        const start = (this.currentPage - 1) * this.rowsPerPage;
        const paginated = this.filteredResponders.slice(start, start + this.rowsPerPage);
        
        paginated.forEach(responder => {
            this.addResponderToTable(responder.id, responder);
        });
        
        this.renderPagination();
    }
    
    renderPagination() {
        if (!this.paginationControls) return;
        this.paginationControls.innerHTML = '';
        
        const totalPages = Math.ceil(this.filteredResponders.length / this.rowsPerPage);
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
        const totalPages = Math.ceil(this.filteredResponders.length / this.rowsPerPage);
        if (page >= 1 && page <= Math.max(1, totalPages)) {
            this.currentPage = page;
            this.renderTable();
        }
    }
    
    updateStats(snapshot) {
        let total = 0;
        let active = 0;
        let inactive = 0;
        let assignedToTeams = 0;
        
        snapshot.forEach(doc => {
            const data = doc.data();
            total++;
            if (data.respIsActive) {
                active++;
            } else {
                inactive++;
            }
            if (data.respAssignedTeamId || data.respTeam) {
                assignedToTeams++;
            }
        });
        
        // Update the stat cards in the HTML
        const statCards = document.querySelectorAll('.stat-value');
        if (statCards.length >= 4) {
            statCards[0].textContent = total;
            statCards[1].textContent = active;
            statCards[2].textContent = inactive;
            statCards[3].textContent = assignedToTeams;
        }
    }
    
    /**
     * Get the next available responder ID (R0, R1, etc.)
     */
    async getNextResponderId() {
        try {
            const q = query(this.responderCollection, orderBy('respID', 'desc'), limit(1));
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) {
                return 'R0'; // First responder
            }
            
            const lastDoc = snapshot.docs[0];
            const lastId = lastDoc.data().respID;
            const numPart = parseInt(lastId.substring(1), 10);
            
            return `R${numPart + 1}`;
        } catch (error) {
            console.error("Error getting next ID:", error);
            return `R${Date.now()}`; // Fallback to timestamp
        }
    }
    
    /**
     * Generate username and password
     */
    generateCredentials() {
        const firstName = this.firstNameInput.value.trim();
        const lastName = this.lastNameInput.value.trim();
        const department = this.departmentSelect.value;
        
        // Generate username (max 6 chars)
        let username = '';
        if (firstName && lastName && department) {
            // Take first 2 chars of first name, first 2 of last name, first 2 of dept
            const firstChars = firstName.substring(0, 2).toLowerCase();
            const lastChars = lastName.substring(0, 2).toLowerCase();
            const deptChars = department.substring(0, 2).toLowerCase();
            
            username = `${firstChars}${lastChars}${deptChars}`;
        }
        
        // Generate random password (12 chars)
        const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
        let password = '';
        for (let i = 0; i < 12; i++) {
            const randomIndex = Math.floor(Math.random() * charset.length);
            password += charset.charAt(randomIndex);
        }
        
        // Update displays
        this.usernameDisplay.textContent = username || 'Username will be generated';
        this.passwordDisplay.textContent = password || 'Password will be generated';
    }
    
    /**
     * Handle form submission to add a new responder
     */
    async handleFormSubmit(e) {
        e.preventDefault();
        
        try {
            // Validate form
            const firstName = this.firstNameInput.value.trim();
            const lastName = this.lastNameInput.value.trim();
            const email = this.emailInput.value.trim();
            const department = this.departmentSelect.value;
            const assignedTeamId = this.assignedTeamSelect ? this.assignedTeamSelect.value : '';
            const username = this.usernameDisplay.textContent;
            const password = this.passwordDisplay.textContent;
            
            // Get team details from cache
            let assignedTeamName = 'Unassigned';
            let assignedTeamType = '';
            if (assignedTeamId) {
                const team = this.teamsCache.find(t => t.id === assignedTeamId);
                if (team) {
                    assignedTeamName = team.name;
                    assignedTeamType = team.type;
                }
            }
            
            if (!firstName || !lastName || !email || !department) {
                alert("Please fill all required fields");
                return;
            }
            
            // Get next responder ID
            const respId = await this.getNextResponderId();
            
            // Create responder data
            const responderData = {
                respID: respId,
                respFirstName: firstName,
                respLastName: lastName,
                respEmail: email,
                respPhone: document.getElementById('phone')?.value || '',
                respDepartment: department,
                respAssignedTeamId: assignedTeamId || null,
                respAssignedTeamName: assignedTeamName,
                respAssignedTeamType: assignedTeamType || null,
                respTeam: assignedTeamName, // For backward compatibility
                respUsername: username,
                respPassword: password, // Plain text here since Admin must have a way to verify, or implement hashing function dynamically if provided
                respGeneratedPassword: password,
                respIsActive: true,
                respCreatedAt: serverTimestamp()
            };
            
            // Add to Firestore with custom document ID
            await setDoc(doc(firestore, 'Responder', respId), responderData);
            
            // Reset form and close modal
            this.form.reset();
            this.addUserModal.style.display = 'none';
            
            alert(`Responder ${respId} added successfully!\nAssigned to: ${assignedTeamName}`);
            
            // Log admin action
            adminLogger.log('create_responder', 'Responder', respId, {
              firstName,
              lastName,
              email,
              department,
              assignedTeamId,
              assignedTeamName
            });
        } catch (error) {
            console.error("Error adding responder:", error);
            alert("Error adding responder. Please try again.");
        }
    }
    
    /**
     * Delete a responder
     */
    async deleteResponder(respId) {
        if (!confirm(`Are you sure you want to delete responder ${respId}?`)) {
            return;
        }
        
        try {
            await deleteDoc(doc(firestore, 'Responder', respId));
            alert(`Responder ${respId} deleted successfully!`);
            
            // Log admin action
            adminLogger.log('delete_responder', 'Responder', respId);
        } catch (error) {
            console.error("Error deleting responder:", error);
            alert("Error deleting responder. Please try again.");
        }
    }
    
    /**
     * Toggle responder active status
     */
    async toggleResponderStatus(respId) {
        try {
            // Get current responder data
            const responderRef = doc(firestore, 'Responder', respId);
            const responderSnap = await getDoc(responderRef);
            
            if (!responderSnap.exists()) {
                alert("Responder not found!");
                return;
            }
            
            const responderData = responderSnap.data();
            const newStatus = !responderData.respIsActive;
            const responderName = `${responderData.respFirstName} ${responderData.respLastName}`;
            
            // Update status
            await updateDoc(responderRef, {
                respIsActive: newStatus
            });
            
            // Don't show alert, let the real-time update handle the visual change
            console.log(`Responder ${responderName} status updated to ${newStatus ? 'Active' : 'Inactive'}`);
            
            // Log admin action
            adminLogger.log('update_responder_status', 'Responder', respId, {
              isActive: newStatus
            });
        } catch (error) {
            console.error("Error updating responder status:", error);
            alert("Error updating responder status. Please try again.");
        }
    }
    
    /**
     * Create and set up the Edit User Modal
     */
    createEditModal() {
        // Check if edit modal already exists in the HTML
        let editModal = document.getElementById('editUserModal');
        
        if (!editModal) {
            console.error("Edit modal container not found in the HTML");
            return;
        }
        
        editModal.innerHTML = `
          <div class="modal-content">
            <div class="modal-header">
              <h2><i class="fas fa-user-edit"></i> Edit Responder</h2>
              <button class="close-button">&times;</button>
            </div>
            <div class="modal-body">
              <form id="editResponderForm">
                <input type="hidden" id="editResponderId">

                <div class="edit-form-row">
                  <div class="form-group">
                    <label for="editFirstName">First Name</label>
                    <input type="text" id="editFirstName" placeholder="First name" required>
                  </div>
                  <div class="form-group">
                    <label for="editLastName">Last Name</label>
                    <input type="text" id="editLastName" placeholder="Last name" required>
                  </div>
                </div>

                <div class="form-group">
                  <label for="editEmail">Email</label>
                  <input type="email" id="editEmail" placeholder="email@example.com">
                </div>

                <div class="form-group">
                  <label for="editPhone">Phone Number</label>
                  <input type="tel" id="editPhone" placeholder="e.g. 09123456789">
                </div>

                <div class="edit-form-row">
                  <div class="form-group">
                    <label for="editDepartment">Department</label>
                    <select id="editDepartment" required>
                      <option value="">Select Department</option>
                      <option value="Fire">Fire</option>
                      <option value="Medical">Medical</option>
                      <option value="Rescue">Rescue</option>
                      <option value="Police">Police</option>
                      <option value="Flood">Flood Response</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label for="editStatus">Status</label>
                    <select id="editStatus" required>
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                  </div>
                </div>

                <div class="form-group">
                  <label for="editAssignedTeam">Assigned Team</label>
                  <select id="editAssignedTeam">
                    <option value="">No Team Assignment</option>
                  </select>
                </div>

                <div class="form-group">
                  <label>Username</label>
                  <div class="password-display">
                    <span id="editUsername">Username will be displayed here</span>
                  </div>
                </div>

                <div class="form-group">
                  <label>Generated Password</label>
                  <div class="password-display" style="display: flex; align-items: center; gap: 8px; background: #f3f4f6; padding: 10px; border-radius: 6px;">
                    <input type="password" id="storedGeneratedPassword" readonly style="border: none; background: transparent; font-family: monospace; font-size: 1rem; width: 100%; outline: none;" value="********">
                    <button type="button" onclick="toggleStoredPassword()" style="background: none; border: none; cursor: pointer; color: #4b5563; font-weight: bold; font-size: 0.85rem; padding: 4px;">
                      [ Show ]
                    </button>
                    <button type="button" onclick="copyStoredPassword()" style="background: none; border: none; cursor: pointer; color: #4b5563; font-weight: bold; font-size: 0.85rem; padding: 4px;">
                      [ Copy ]
                    </button>
                  </div>
                </div>

                <div class="form-group" style="margin-top: 16px;">
                  <label>Reset Password</label>
                  <button type="button" id="resetPasswordBtn" class="reset-password-button">
                    <i class="fas fa-key"></i> Generate New Password
                  </button>
                  <div class="password-display" id="newPasswordContainer" style="display: none; margin-top: 8px;">
                    <span id="newPassword"></span>
                    <button type="button" class="copy-password" onclick="copyNewPassword()">
                      <i class="fas fa-copy"></i> Copy
                    </button>
                  </div>
                </div>

                <div class="form-actions">
                  <button type="button" class="btn btn-secondary cancel-button">Cancel</button>
                  <button type="submit" class="btn btn-primary">
                    <i class="fas fa-save"></i> Update Responder
                  </button>
                </div>
              </form>
            </div>
          </div>
        `;
        
        // Add event listeners for the edit modal
        const closeButton = editModal.querySelector('.close-button');
        closeButton.addEventListener('click', () => {
          editModal.style.display = 'none';
        });
        
        const cancelButton = editModal.querySelector('.cancel-button');
        cancelButton.addEventListener('click', () => {
          editModal.style.display = 'none';
        });
        
        // Setup reset password button
        const resetPasswordBtn = document.getElementById('resetPasswordBtn');
        resetPasswordBtn.addEventListener('click', () => this.generateNewPassword());
        
        // Setup form submission
        const editForm = document.getElementById('editResponderForm');
        editForm.addEventListener('submit', (e) => this.handleEditFormSubmit(e));
        
        // Add global function for copying new password
        window.copyNewPassword = function() {
          const password = document.getElementById('newPassword').textContent;
          navigator.clipboard.writeText(password).then(() => {
            alert('New password copied to clipboard!');
          });
        };

        let isStoredVisible = false;
        window.toggleStoredPassword = function() {
          isStoredVisible = !isStoredVisible;
          const pwdField = document.getElementById('storedGeneratedPassword');
          pwdField.type = isStoredVisible ? 'text' : 'password';
        };

        window.copyStoredPassword = function() {
          const pwd = document.getElementById('storedGeneratedPassword').value;
          if (pwd && pwd !== '********' && pwd !== 'None') {
            navigator.clipboard.writeText(pwd).then(() => {
              alert('Generated password copied to clipboard!');
            });
          }
        };
    }
    
    /**
     * Open edit modal and populate with responder data
     */
    async openEditModal(respId) {
        try {
            const responderRef = doc(firestore, 'Responder', respId);
            const responderSnap = await getDoc(responderRef);
            
            if (!responderSnap.exists()) {
                alert('Responder not found!');
                return;
            }
            
            const responder = responderSnap.data();
            
            // Reset all form fields first to prevent stale data
            const editForm = document.getElementById('editResponderForm');
            if (editForm) editForm.reset();
            document.getElementById('newPasswordContainer').style.display = 'none';
            
            // Populate form fields
            document.getElementById('editResponderId').value = respId;
            document.getElementById('editFirstName').value = responder.respFirstName || '';
            document.getElementById('editLastName').value = responder.respLastName || '';
            document.getElementById('editEmail').value = responder.respEmail || '';
            
            // Phone: check multiple possible Firestore field names
            const phone = responder.respPhone || responder.respContactNumber || responder.respPhoneNumber || responder.phone || '';
            const phoneField = document.getElementById('editPhone');
            if (phoneField) phoneField.value = phone;
            
            // Department: try case-insensitive match against dropdown options
            const deptSelect = document.getElementById('editDepartment');
            const deptValue = responder.respDepartment || '';
            if (deptSelect) {
                deptSelect.value = deptValue;
                if (!deptSelect.value && deptValue) {
                    for (const opt of deptSelect.options) {
                        if (opt.value.toLowerCase() === deptValue.toLowerCase()) {
                            deptSelect.value = opt.value;
                            break;
                        }
                    }
                }
            }
            
            // Update assigned team dropdown and set value
            this.updateTeamDropdowns();
            const editTeamSelect = document.getElementById('editAssignedTeam');
            if (editTeamSelect) {
                const teamId = responder.respAssignedTeamId || '';
                if (teamId) {
                    editTeamSelect.value = teamId;
                    if (editTeamSelect.value !== teamId) {
                        const option = document.createElement('option');
                        option.value = teamId;
                        option.textContent = responder.respAssignedTeamName || responder.respTeam || teamId;
                        editTeamSelect.appendChild(option);
                        editTeamSelect.value = teamId;
                    }
                }
            }
            
            // Set status
            const isActive = responder.respIsActive === true || responder.respIsActive === 'true';
            document.getElementById('editStatus').value = isActive.toString();
            
            // Display username
            document.getElementById('editUsername').textContent = responder.respUsername || 'No username assigned';
            
            // Display stored generated password (hidden by default)
            const pwdInput = document.getElementById('storedGeneratedPassword');
            pwdInput.value = responder.respGeneratedPassword || 'None';
            pwdInput.type = 'password';
            
            // Show the modal
            document.getElementById('editUserModal').style.display = 'block';
            
            console.log('Edit modal loaded for:', respId, { phone, dept: deptValue, teamId: responder.respAssignedTeamId });
            
        } catch (error) {
            console.error("Error loading responder data:", error);
            alert("Error loading responder data. Please try again.");
        }
    }
    
    /**
     * Generate a new random password
     */
    generateNewPassword() {
        const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
        let password = '';
        for (let i = 0; i < 12; i++) {
            const randomIndex = Math.floor(Math.random() * charset.length);
            password += charset.charAt(randomIndex);
        }
        
        // Display the new password
        const passwordContainer = document.getElementById('newPasswordContainer');
        const passwordElement = document.getElementById('newPassword');
        passwordElement.textContent = password;
        passwordContainer.style.display = 'flex';
    }
    
    /**
     * Handle edit form submission
     */
    async handleEditFormSubmit(e) {
        e.preventDefault();
        
        try {
            const respId = document.getElementById('editResponderId').value;
            const assignedTeamId = document.getElementById('editAssignedTeam')?.value || '';
            
            // Get team details from cache
            let assignedTeamName = 'Unassigned';
            let assignedTeamType = '';
            if (assignedTeamId) {
                const team = this.teamsCache.find(t => t.id === assignedTeamId);
                if (team) {
                    assignedTeamName = team.name;
                    assignedTeamType = team.type;
                }
            }
            
            // Gather form data
            const updateData = {
                respFirstName: document.getElementById('editFirstName').value,
                respLastName: document.getElementById('editLastName').value,
                respEmail: document.getElementById('editEmail').value,
                respPhone: document.getElementById('editPhone')?.value || '',
                respDepartment: document.getElementById('editDepartment').value,
                respAssignedTeamId: assignedTeamId || null,
                respAssignedTeamName: assignedTeamName,
                respAssignedTeamType: assignedTeamType || null,
                respTeam: assignedTeamName, // For backward compatibility
                respIsActive: document.getElementById('editStatus').value === 'true'
            };
            
            // If a new password was generated, include it
            const newPasswordContainer = document.getElementById('newPasswordContainer');
            if (newPasswordContainer.style.display !== 'none') {
                const newPass = document.getElementById('newPassword').textContent;
                updateData.respPassword = newPass; 
                updateData.respGeneratedPassword = newPass;
            }
            
            // Update in Firestore - Use imported Firebase functions directly
            const responderRef = doc(firestore, 'Responder', respId);
            await updateDoc(responderRef, updateData);
            
            // Close the modal
            document.getElementById('editUserModal').style.display = 'none';
            
            alert('Responder updated successfully!');
            
            // Log admin action
            adminLogger.log('update_responder', 'Responder', respId, {
              ...updateData
            });
        } catch (error) {
            console.error("Error updating responder:", error);
            alert("Error updating responder. Please try again.");
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    initAdminRealtimeHub();
    new ResponderManager();
});

// Export for module usage
export default ResponderManager;