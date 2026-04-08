// Import Firebase modules
import { 
    firestore, 
    collection, 
    query, 
    where, 
    getDocs,
    orderBy,
    limit,
    startAfter,
    doc,
    getDoc,
    deleteDoc
} from './firebase-api.js';

// History Manager Class
class HistoryManager {
    constructor() {
        this.allHistory = [];
        this.filteredHistory = [];
        this.currentPage = 1;
        this.itemsPerPage = 9999; // Show all items without pagination
        this.totalPages = 1;
        this.isLoading = false;
        this.lastLoaded = null;
        this.selectedItems = new Set(); // { id|collection } keys for checked rows
        this.currentFilters = {
            dateFrom: null,
            dateTo: null,
            eventType: '',
            location: ''
        };
        
        this.init();
    }

    async init() {
        // Show loading state immediately
        this.showLoadingStats();
        this.setupEventListeners();
        
        // Load data
        await this.loadAllHistory();
        
        // Update UI
        this.updateStats();
        this.renderTable();
        this.renderPagination();
    }

    showLoadingStats() {
        const cards = document.querySelectorAll('.summary-card h4');
        if (cards.length >= 4) {
            cards[0].innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size: 1rem;"></i>';
            cards[1].innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size: 1rem;"></i>';
            cards[2].innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size: 1rem;"></i>';
            cards[3].innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size: 1rem;"></i>';
        }
    }

    setupEventListeners() {
        // Filter button
        document.querySelector('.filter-actions .btn-primary')?.addEventListener('click', () => {
            this.applyFilters();
        });

        // Clear filter button
        document.querySelector('.filter-actions .btn-secondary')?.addEventListener('click', () => {
            this.clearFilters();
        });

        // Export button
        document.querySelector('.header-actions .btn-secondary')?.addEventListener('click', () => {
            this.exportHistory();
        });

        // Filter inputs - apply on Enter key
        document.getElementById('location')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.applyFilters();
        });

        // Event type change - auto apply
        document.getElementById('event-type')?.addEventListener('change', () => {
            this.applyFilters();
        });

        // Date change - auto apply
        document.getElementById('date-from')?.addEventListener('change', () => {
            this.applyFilters();
        });
        document.getElementById('date-to')?.addEventListener('change', () => {
            this.applyFilters();
        });

        // ── Select-all checkbox ──────────────────────────────────────────────
        document.getElementById('selectAllCheckbox')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                this.selectAllVisible();
            } else {
                this.clearSelection();
            }
        });

        // ── Bulk period quick-select buttons ────────────────────────────────
        document.querySelectorAll('.bulk-period-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.bulk-period-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.selectByPeriod(btn.dataset.bulk);
            });
        });

        // ── Clear selection ──────────────────────────────────────────────────
        document.getElementById('clearSelectionBtn')?.addEventListener('click', () => {
            document.querySelectorAll('.bulk-period-btn').forEach(b => b.classList.remove('active'));
            this.clearSelection();
        });

        // ── Bulk delete trigger ──────────────────────────────────────────────
        document.getElementById('bulkDeleteBtn')?.addEventListener('click', () => {
            if (this.selectedItems.size === 0) return;
            this.confirmBulkDelete();
        });
    }

    // Force refresh data from Firebase
    async refreshData() {
        if (this.isLoading) return;
        
        this.isLoading = true;
        this.showLoadingStats();
        
        const tbody = document.getElementById('history-table-body');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 40px; color: var(--gray-500);">
                        <i class="fas fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 12px; display: block;"></i>
                        Refreshing...
                    </td>
                </tr>
            `;
        }
        
        await this.loadAllHistory();
        this.updateStats();
        this.renderTable();
        this.renderPagination();
        
        this.isLoading = false;
        this.lastLoaded = Date.now();
    }

    async loadAllHistory() {
        this.isLoading = true;
        
        try {
            this.allHistory = [];

            // Load ALL collections in PARALLEL for faster loading
            const [alertsSnapshot, reportsSnapshot, sosSnapshot] = await Promise.all([
                getDocs(collection(firestore, 'Alerts')),
                getDocs(collection(firestore, 'Reports')),
                getDocs(collection(firestore, 'SOS'))
            ]);

            // Process Alerts (Admin created)
            alertsSnapshot.forEach(doc => {
                const data = doc.data();
                this.allHistory.push({
                    id: doc.id,
                    ...data,
                    eventType: 'alert',
                    eventLabel: 'Alert',
                    eventIcon: 'fa-bullhorn',
                    description: `${data.type || 'Alert'}: ${data.details || data.description || 'No details'}`,
                    collection: 'Alerts'
                });
            });

            // Process Reports (Citizen emergencies)
            reportsSnapshot.forEach(doc => {
                const data = doc.data();
                this.allHistory.push({
                    id: doc.id,
                    ...data,
                    eventType: 'emergency',
                    eventLabel: 'Emergency',
                    eventIcon: 'fa-exclamation-triangle',
                    description: `${data.type || 'Emergency'}: ${data.details || data.description || data.message || 'No details'}`,
                    collection: 'Reports'
                });
            });

            // Process SOS (Critical emergencies)
            sosSnapshot.forEach(doc => {
                const data = doc.data();
                this.allHistory.push({
                    id: doc.id,
                    ...data,
                    eventType: 'sos',
                    eventLabel: 'SOS Emergency',
                    eventIcon: 'fa-exclamation-circle',
                    description: `SOS from ${data.reportedByName || data.reportedBy || 'Unknown'}: ${data.message || 'Emergency assistance needed'}`,
                    collection: 'SOS'
                });
            });

            // Sort by timestamp (newest first)
            this.allHistory.sort((a, b) => {
                const timeA = a.timestamp?.toDate?.() || new Date(a.timestamp || 0);
                const timeB = b.timestamp?.toDate?.() || new Date(b.timestamp || 0);
                return timeB - timeA;
            });

            // Apply initial filters
            this.filteredHistory = [...this.allHistory];
            this.calculatePagination();
            
            this.isLoading = false;
            this.lastLoaded = Date.now();

            console.log(`Loaded ${this.allHistory.length} history records`);
        } catch (error) {
            console.error('Error loading history:', error);
            this.isLoading = false;
            
            // Show error in table
            const tbody = document.getElementById('history-table-body');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 40px; color: #ef4444;">
                            <i class="fas fa-exclamation-triangle" style="font-size: 2rem; margin-bottom: 12px; display: block;"></i>
                            Failed to load history. Please refresh the page.
                        </td>
                    </tr>
                `;
            }
            
            // Reset stats on error
            const cards = document.querySelectorAll('.summary-card h4');
            if (cards.length >= 4) {
                cards[0].textContent = '0';
                cards[1].textContent = '0';
                cards[2].textContent = '0';
                cards[3].textContent = '0%';
            }
        }
    }

    applyFilters() {
        // Get filter values
        this.currentFilters.dateFrom = document.getElementById('date-from')?.value || null;
        this.currentFilters.dateTo = document.getElementById('date-to')?.value || null;
        this.currentFilters.eventType = document.getElementById('event-type')?.value || '';
        this.currentFilters.location = document.getElementById('location')?.value?.toLowerCase() || '';

        // Filter the history
        this.filteredHistory = this.allHistory.filter(item => {
            // Date from filter
            if (this.currentFilters.dateFrom) {
                const itemDate = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
                const fromDate = new Date(this.currentFilters.dateFrom);
                fromDate.setHours(0, 0, 0, 0);
                if (itemDate < fromDate) return false;
            }

            // Date to filter
            if (this.currentFilters.dateTo) {
                const itemDate = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
                const toDate = new Date(this.currentFilters.dateTo);
                toDate.setHours(23, 59, 59, 999);
                if (itemDate > toDate) return false;
            }

            // Event type filter
            if (this.currentFilters.eventType) {
                if (item.eventType !== this.currentFilters.eventType) return false;
            }

            // Location filter
            if (this.currentFilters.location) {
                const itemLocation = (item.location || '').toLowerCase();
                if (!itemLocation.includes(this.currentFilters.location)) return false;
            }

            return true;
        });

        // Reset to first page and re-render
        this.currentPage = 1;
        this.calculatePagination();
        this.renderTable();
        this.renderPagination();
        this.updateStats();
    }

    clearFilters() {
        // Reset filter inputs
        document.getElementById('date-from').value = '';
        document.getElementById('date-to').value = '';
        document.getElementById('event-type').value = '';
        document.getElementById('location').value = '';

        // Reset filters
        this.currentFilters = {
            dateFrom: null,
            dateTo: null,
            eventType: '',
            location: ''
        };

        // Reset filtered data
        this.filteredHistory = [...this.allHistory];
        this.currentPage = 1;
        this.calculatePagination();
        this.renderTable();
        this.renderPagination();
        this.updateStats();
    }

    calculatePagination() {
        this.totalPages = Math.ceil(this.filteredHistory.length / this.itemsPerPage);
        if (this.totalPages === 0) this.totalPages = 1;
        if (this.currentPage > this.totalPages) this.currentPage = this.totalPages;
    }

    getCurrentPageData() {
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        return this.filteredHistory.slice(startIndex, endIndex);
    }

    renderTable() {
        const tbody = document.getElementById('history-table-body');
        if (!tbody) return;

        const pageData = this.getCurrentPageData();

        if (pageData.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 40px; color: var(--gray-500);">
                        <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: 12px; display: block;"></i>
                        No history records found
                    </td>
                </tr>
            `;
            this.updateTableHeader(0);
            return;
        }

        tbody.innerHTML = pageData.map((item, index) => {
            const globalIndex = (this.currentPage - 1) * this.itemsPerPage + index + 1;
            const timestamp = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
            const dateStr = timestamp.toLocaleDateString('en-US', { 
                year: 'numeric', month: 'short', day: 'numeric' 
            });
            const timeStr = timestamp.toLocaleTimeString('en-US', { 
                hour: '2-digit', minute: '2-digit' 
            });

            let badgeClass = 'status';
            switch (item.eventType) {
                case 'alert':     badgeClass = 'alert';    break;
                case 'emergency': badgeClass = 'incident'; break;
                case 'sos':       badgeClass = 'incident'; break;
            }

            const isResolved = item.status === 'inactive' || item.isResolved;
            const statusIndicator = isResolved 
                ? '<span style="color: #10b981; font-size: 0.75rem;"><i class="fas fa-check-circle"></i> Resolved</span>'
                : '<span style="color: #f59e0b; font-size: 0.75rem;"><i class="fas fa-clock"></i> Active</span>';

            const itemKey    = `${item.id}|${item.collection}`;
            const isSelected = this.selectedItems.has(itemKey);
            const safeLabel  = (item.eventLabel || 'Record').replace(/"/g, '&quot;');

            return `
                <tr class="${isSelected ? 'selected-row' : ''}" data-key="${itemKey}">
                    <td style="text-align:center;">
                        <input type="checkbox"
                               class="row-checkbox"
                               data-key="${itemKey}"
                               ${isSelected ? 'checked' : ''}>
                    </td>
                    <td><strong>#${String(globalIndex).padStart(3, '0')}</strong></td>
                    <td>
                        <div>${dateStr}</div>
                        <small style="color: var(--gray-500);">${timeStr}</small>
                    </td>
                    <td>
                        <span class="event-type-badge ${badgeClass}">
                            <i class="fas ${item.eventIcon}"></i> ${item.eventLabel}
                        </span>
                    </td>
                    <td>
                        <div style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${item.description}
                        </div>
                        ${statusIndicator}
                    </td>
                    <td>${item.location || 'Unknown'}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn btn-sm btn-secondary view-details-btn"
                                data-id="${item.id}"
                                data-collection="${item.collection}"
                                style="margin-right:5px;">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button class="btn btn-sm delete-record-btn"
                                data-id="${item.id}"
                                data-collection="${item.collection}"
                                data-label="${safeLabel}"
                                title="Delete permanently (Admin only)"
                                style="background:#ef4444;color:#fff;border:none;padding:5px 10px;
                                       border-radius:5px;cursor:pointer;font-size:0.8rem;font-weight:600;">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        // View button listeners
        tbody.querySelectorAll('.view-details-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.showDetails(btn.dataset.id, btn.dataset.collection);
            });
        });

        // Single delete button listeners
        tbody.querySelectorAll('.delete-record-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.confirmDelete(btn.dataset.id, btn.dataset.collection, btn.dataset.label || 'Record');
            });
        });

        // Row checkbox listeners
        tbody.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const key = e.target.dataset.key;
                if (e.target.checked) {
                    this.selectedItems.add(key);
                    e.target.closest('tr').classList.add('selected-row');
                } else {
                    this.selectedItems.delete(key);
                    e.target.closest('tr').classList.remove('selected-row');
                }
                this.updateBulkToolbar();
                this.syncSelectAllCheckbox();
            });
        });

        this.updateTableHeader(this.filteredHistory.length);
        this.syncSelectAllCheckbox();
    }

    updateTableHeader(totalShowing) {
        const headerSpan = document.querySelector('.table-card .card-header span');
        if (headerSpan) {
            const start = (this.currentPage - 1) * this.itemsPerPage + 1;
            const end = Math.min(this.currentPage * this.itemsPerPage, this.filteredHistory.length);
            if (totalShowing > 0) {
                headerSpan.textContent = `Showing ${start}-${end} of ${totalShowing} entries`;
            } else {
                headerSpan.textContent = 'No entries found';
            }
        }
    }

    renderPagination() {
        const paginationContainer = document.querySelector('.pagination');
        if (!paginationContainer) return;

        let buttons = [];

        // Previous button
        buttons.push(`
            <button class="pagination-button" data-page="prev" ${this.currentPage === 1 ? 'disabled' : ''}>
                &laquo;
            </button>
        `);

        // Page numbers
        const maxVisiblePages = 5;
        let startPage = Math.max(1, this.currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(this.totalPages, startPage + maxVisiblePages - 1);

        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }

        // First page if not visible
        if (startPage > 1) {
            buttons.push(`<button class="pagination-button" data-page="1">1</button>`);
            if (startPage > 2) {
                buttons.push(`<button class="pagination-button" disabled>...</button>`);
            }
        }

        // Page numbers
        for (let i = startPage; i <= endPage; i++) {
            buttons.push(`
                <button class="pagination-button ${i === this.currentPage ? 'active' : ''}" data-page="${i}">
                    ${i}
                </button>
            `);
        }

        // Last page if not visible
        if (endPage < this.totalPages) {
            if (endPage < this.totalPages - 1) {
                buttons.push(`<button class="pagination-button" disabled>...</button>`);
            }
            buttons.push(`<button class="pagination-button" data-page="${this.totalPages}">${this.totalPages}</button>`);
        }

        // Next button
        buttons.push(`
            <button class="pagination-button" data-page="next" ${this.currentPage === this.totalPages ? 'disabled' : ''}>
                &raquo;
            </button>
        `);

        paginationContainer.innerHTML = buttons.join('');

        // Add click listeners
        paginationContainer.querySelectorAll('.pagination-button:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = btn.dataset.page;
                if (page === 'prev') {
                    this.goToPage(this.currentPage - 1);
                } else if (page === 'next') {
                    this.goToPage(this.currentPage + 1);
                } else {
                    this.goToPage(parseInt(page));
                }
            });
        });
    }

    goToPage(page) {
        if (page < 1 || page > this.totalPages) return;
        this.currentPage = page;
        this.renderTable();
        this.renderPagination();

        // Scroll to top of table
        document.querySelector('.table-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    updateStats() {
        const total = this.filteredHistory.length;
        const resolved = this.filteredHistory.filter(item => item.status === 'inactive' || item.isResolved).length;
        const ongoing = total - resolved;
        const resolutionRate = total > 0 ? Math.round((resolved / total) * 100) : 0;

        // Update stat cards
        const cards = document.querySelectorAll('.summary-card h4');
        if (cards.length >= 4) {
            cards[0].textContent = total;
            cards[1].textContent = resolved;
            cards[2].textContent = ongoing;
            cards[3].textContent = `${resolutionRate}%`;
        }
    }

    showDetails(id, collectionName) {
        const item = this.allHistory.find(h => h.id === id && h.collection === collectionName);
        if (!item) return;

        // Create or get modal
        let modal = document.getElementById('detailModal');
        if (!modal) {
            modal = this.createDetailModal();
            document.body.appendChild(modal);
        }

        const timestamp = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
        const isResolved = item.status === 'inactive' || item.isResolved;

        // Get header color based on type
        let headerColor;
        switch (item.eventType) {
            case 'alert': headerColor = 'linear-gradient(135deg, #f97316, #ea580c)'; break;
            case 'emergency': headerColor = 'linear-gradient(135deg, #eab308, #ca8a04)'; break;
            case 'sos': headerColor = 'linear-gradient(135deg, #ef4444, #dc2626)'; break;
            default: headerColor = 'linear-gradient(135deg, #6366f1, #4f46e5)';
        }

        // Populate modal
        document.getElementById('detail-modal-header').style.background = headerColor;
        document.getElementById('detail-modal-title').innerHTML = `<i class="fas ${item.eventIcon}"></i> ${item.eventLabel} Details`;
        
        document.getElementById('detail-modal-body').innerHTML = `
            <div class="detail-row">
                <i class="fas fa-hashtag"></i>
                <div>
                    <div class="detail-label">Record ID</div>
                    <div class="detail-value" style="font-family: monospace;">${item.id}</div>
                </div>
            </div>
            <div class="detail-row">
                <i class="fas fa-tag"></i>
                <div>
                    <div class="detail-label">Type</div>
                    <div class="detail-value">${item.type || item.eventLabel}</div>
                </div>
            </div>
            <div class="detail-row">
                <i class="fas fa-circle-info"></i>
                <div>
                    <div class="detail-label">Status</div>
                    <div class="detail-value">
                        ${isResolved 
                            ? '<span style="color: #10b981; font-weight: 600;"><i class="fas fa-check-circle"></i> Resolved</span>' 
                            : '<span style="color: #f59e0b; font-weight: 600;"><i class="fas fa-clock"></i> Active/Ongoing</span>'}
                    </div>
                </div>
            </div>
            <div class="detail-row">
                <i class="fas fa-map-marker-alt"></i>
                <div>
                    <div class="detail-label">Location</div>
                    <div class="detail-value">${item.location || 'Not specified'}</div>
                </div>
            </div>
            <div class="detail-row">
                <i class="fas fa-clock"></i>
                <div>
                    <div class="detail-label">Date & Time</div>
                    <div class="detail-value">${timestamp.toLocaleString()}</div>
                </div>
            </div>
            ${item.reportedByName || item.reportedBy ? `
                <div class="detail-row">
                    <i class="fas fa-user"></i>
                    <div>
                        <div class="detail-label">Reported By</div>
                        <div class="detail-value">${item.reportedByName || item.reportedBy}</div>
                    </div>
                </div>
            ` : ''}
            ${item.reportedByContactNumber ? `
                <div class="detail-row">
                    <i class="fas fa-phone"></i>
                    <div>
                        <div class="detail-label">Contact</div>
                        <div class="detail-value">
                            <a href="tel:${item.reportedByContactNumber}">${item.reportedByContactNumber}</a>
                        </div>
                    </div>
                </div>
            ` : ''}
            ${item.assignedTeamName ? `
                <div class="detail-row" style="background: #d1fae5; padding: 12px; border-radius: 8px;">
                    <i class="fas fa-users" style="color: #059669;"></i>
                    <div>
                        <div class="detail-label" style="color: #059669;">Assigned Team</div>
                        <div class="detail-value" style="color: #059669; font-weight: 600;">${item.assignedTeamName}</div>
                    </div>
                </div>
            ` : ''}
            <div class="detail-row">
                <i class="fas fa-file-alt"></i>
                <div>
                    <div class="detail-label">Details</div>
                    <div class="detail-value">${item.details || item.description || item.message || 'No additional details'}</div>
                </div>
            </div>
            ${item.coordinates ? `
                <div class="detail-row">
                    <i class="fas fa-location-crosshairs"></i>
                    <div>
                        <div class="detail-label">Coordinates</div>
                        <div class="detail-value">
                            ${item.coordinates.latitude?.toFixed(6) || item.coordinates.lat?.toFixed(6)}, 
                            ${item.coordinates.longitude?.toFixed(6) || item.coordinates.lng?.toFixed(6)}
                            <a href="https://www.google.com/maps?q=${item.coordinates.latitude || item.coordinates.lat},${item.coordinates.longitude || item.coordinates.lng}" 
                               target="_blank" 
                               style="margin-left: 10px; color: var(--primary);">
                                <i class="fas fa-external-link-alt"></i> View on Map
                            </a>
                        </div>
                    </div>
                </div>
            ` : ''}
        `;

        modal.style.display = 'flex';
    }

    createDetailModal() {
        const modal = document.createElement('div');
        modal.id = 'detailModal';
        modal.className = 'detail-modal';
        modal.innerHTML = `
            <div class="detail-content">
                <div class="detail-header" id="detail-modal-header">
                    <h2 id="detail-modal-title">Details</h2>
                    <button class="detail-close" onclick="document.getElementById('detailModal').style.display='none'">&times;</button>
                </div>
                <div class="detail-body" id="detail-modal-body">
                    <!-- Dynamic content -->
                </div>
                <div class="detail-footer">
                    <button class="btn btn-secondary" onclick="document.getElementById('detailModal').style.display='none'">
                        <i class="fas fa-times"></i> Close
                    </button>
                </div>
            </div>
        `;

        // Close on backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });

        return modal;
    }

    exportHistory() {
        if (this.filteredHistory.length === 0) {
            alert('No data to export');
            return;
        }

        // ── CSV helper: wrap a cell value in quotes and escape inner quotes ──
        // Any field that contains a comma, double-quote, or newline MUST be
        // wrapped in double-quotes. Inner double-quotes are escaped as "".
        function csvCell(value) {
            const str = String(value === null || value === undefined ? '' : value)
                .replace(/\r?\n/g, ' ')   // flatten newlines to a space
                .replace(/"/g, '""');       // escape existing quotes
            // Always quote so Excel never mis-parses dates, IDs, or addresses
            return `"${str}"`;
        }

        const headers = ['ID', 'Date/Time', 'Type', 'Description', 'Location', 'Status', 'Reported By'];

        const rows = this.filteredHistory.map((item, index) => {
            const timestamp = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
            const month    = String(timestamp.getMonth() + 1).padStart(2, '0');
            const day      = String(timestamp.getDate()).padStart(2, '0');
            const year     = timestamp.getFullYear();
            const hours    = String(timestamp.getHours()).padStart(2, '0');
            const minutes  = String(timestamp.getMinutes()).padStart(2, '0');
            const seconds  = String(timestamp.getSeconds()).padStart(2, '0');
            const dateStr  = `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;

            const isResolved = item.status === 'inactive' || item.isResolved;
            const reporter   = item.reportedByName || item.reportedBy || 'Admin/System';

            // Each field goes through csvCell() — commas inside are safe
            return [
                csvCell(`#${String(index + 1).padStart(3, '0')}`),
                csvCell(dateStr),
                csvCell(item.eventLabel),
                csvCell(item.description || ''),
                csvCell(item.location || 'Unknown'),
                csvCell(isResolved ? 'Resolved' : 'Active'),
                csvCell(reporter)
            ].join(',');   // ← comma separator (was \t which broke Excel columns)
        });

        // UTF-8 BOM ensures Excel opens the file with correct encoding
        const BOM = '\uFEFF';
        const csv = BOM + [headers.map(csvCell).join(','), ...rows].join('\r\n');

        // Save as .csv so Excel automatically splits on commas into columns
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `cdrrmo_history_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
    /**
     * updateBulkToolbar — show/hide toolbar and sync count badges.
     */
    updateBulkToolbar() {
        const toolbar   = document.getElementById('bulkToolbar');
        const countLabel = document.getElementById('selectedCountLabel');
        const deleteBtn  = document.getElementById('bulkDeleteBtn');
        const deleteCount = document.getElementById('bulkDeleteCount');
        const n = this.selectedItems.size;

        if (toolbar)      toolbar.classList.toggle('visible', n > 0);
        if (countLabel)   countLabel.textContent = `${n} selected`;
        if (deleteCount)  deleteCount.textContent = n;
        if (deleteBtn)    deleteBtn.disabled = (n === 0);
    }

    /**
     * syncSelectAllCheckbox — keeps the header checkbox in sync.
     */
    syncSelectAllCheckbox() {
        const cb      = document.getElementById('selectAllCheckbox');
        if (!cb) return;
        const visible = this.getCurrentPageData();
        if (visible.length === 0) { cb.checked = false; cb.indeterminate = false; return; }
        const selectedVisible = visible.filter(item =>
            this.selectedItems.has(`${item.id}|${item.collection}`)
        ).length;
        cb.checked       = selectedVisible === visible.length;
        cb.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    }

    /**
     * selectAllVisible — selects every row currently showing in the table.
     */
    selectAllVisible() {
        this.getCurrentPageData().forEach(item => {
            this.selectedItems.add(`${item.id}|${item.collection}`);
        });
        this.renderTable();
        this.updateBulkToolbar();
    }

    /**
     * clearSelection — deselects everything.
     */
    clearSelection() {
        this.selectedItems.clear();
        const selectAll = document.getElementById('selectAllCheckbox');
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
        this.renderTable();
        this.updateBulkToolbar();
    }

    /**
     * selectByPeriod — REPLACES current selection with records matching
     * the given time window or status filter.
     * Periods: today | yesterday | last7 | last30 | resolved | all_visible
     */
    selectByPeriod(period) {
        const now        = new Date();
        const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0);       return x; };
        const endOfDay   = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999);   return x; };

        const todayStart     = startOfDay(now);
        const todayEnd       = endOfDay(now);
        const yesterdayStart = startOfDay(new Date(now - 86400000));
        const yesterdayEnd   = endOfDay(new Date(now - 86400000));
        const last7Start     = new Date(now - 7  * 86400000);
        const last30Start    = new Date(now - 30 * 86400000);

        // FIX: CLEAR first so clicking a button always REPLACES selection
        this.selectedItems.clear();

        let matchCount = 0;

        this.filteredHistory.forEach(item => {
            const ts = item.timestamp?.toDate?.() || new Date(item.timestamp || 0);
            const isResolved = item.status === 'inactive' || item.isResolved;
            let match = false;

            switch (period) {
                case 'today':       match = ts >= todayStart && ts <= todayEnd;         break;
                case 'yesterday':   match = ts >= yesterdayStart && ts <= yesterdayEnd; break;
                case 'last7':       match = ts >= last7Start && ts <= todayEnd;         break;
                case 'last30':      match = ts >= last30Start && ts <= todayEnd;        break;
                case 'resolved':    match = isResolved;                                 break;
                case 'all_visible': match = true;                                       break;
            }

            if (match) {
                this.selectedItems.add(`${item.id}|${item.collection}`);
                matchCount++;
            }
        });

        // FIX: Show clear feedback so admin knows what happened
        this._showPeriodToast(period, matchCount);

        this.renderTable();
        this.updateBulkToolbar();
    }

    /**
     * _showPeriodToast — brief feedback toast after a period selection.
     */
    _showPeriodToast(period, count) {
        // Remove existing toast if any
        const existing = document.getElementById('periodToast');
        if (existing) existing.remove();

        const labels = {
            today:       'Today',
            yesterday:   'Yesterday',
            last7:       'Last 7 Days',
            last30:      'Last 30 Days',
            resolved:    'All Resolved',
            all_visible: 'All Visible',
        };

        const toast = document.createElement('div');
        toast.id = 'periodToast';
        toast.style.cssText = `
            position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
            z-index: 9999; padding: 10px 22px; border-radius: 8px;
            font-size: 0.88rem; font-weight: 600; color: #fff;
            box-shadow: 0 6px 20px rgba(0,0,0,0.25);
            animation: slideDown 0.2s ease;
            white-space: nowrap;
            background: ${count > 0 ? '#1e40af' : '#6b7280'};
        `;

        toast.innerHTML = count > 0
            ? `<i class="fas fa-check-circle"></i> ${count} record${count !== 1 ? 's' : ''} selected — <em>${labels[period] || period}</em>`
            : `<i class="fas fa-info-circle"></i> No records found for <em>${labels[period] || period}</em>`;

        document.body.appendChild(toast);
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 3000);
    }

    /**
     * confirmBulkDelete — shows the confirmation modal for bulk delete.
     */
    confirmBulkDelete() {
        const n     = this.selectedItems.size;
        const modal = document.getElementById('deleteConfirmModal');
        if (!modal) {
            if (confirm(`⚠️ Delete ${n} record${n > 1 ? 's' : ''}?\n\nThis is PERMANENT and cannot be undone.`)) {
                this.executeBulkDelete();
            }
            return;
        }

        const titleEl    = document.getElementById('deleteModalTitle');
        const subtitleEl = document.getElementById('deleteModalSubtitle');
        const infoEl     = document.getElementById('deleteRecordInfo');
        const confirmBtn = document.getElementById('deleteConfirmBtn');
        const cancelBtn  = document.getElementById('deleteCancelBtn');

        if (titleEl)    titleEl.textContent = `Delete ${n} Record${n > 1 ? 's' : ''}?`;
        if (subtitleEl) subtitleEl.innerHTML = `You are about to permanently delete <strong>${n} record${n > 1 ? 's' : ''}</strong>. This cannot be undone.`;
        if (infoEl) {
            // Show a brief breakdown by type
            const byType = {};
            this.selectedItems.forEach(key => {
                const [id, col] = key.split('|');
                byType[col] = (byType[col] || 0) + 1;
            });
            infoEl.innerHTML = Object.entries(byType)
                .map(([col, count]) => `<strong>${col}:</strong> ${count} record${count > 1 ? 's' : ''}`)
                .join('<br>');
        }

        if (confirmBtn) {
            const newBtn = confirmBtn.cloneNode(true);
            confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
            newBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                this.executeBulkDelete();
            });
        }
        if (cancelBtn) cancelBtn.onclick = () => { modal.style.display = 'none'; };

        modal.style.display = 'flex';
    }

    /**
     * executeBulkDelete — runs all deletions in parallel with a progress toast.
     */
    async executeBulkDelete() {
        const keys = [...this.selectedItems];
        const n    = keys.length;

        // Progress toast
        const toast = document.createElement('div');
        toast.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;
            background:#1e40af;color:#fff;padding:12px 20px;border-radius:8px;
            font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);min-width:220px;`;
        toast.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Deleting ${n} record${n > 1 ? 's' : ''}…`;
        document.body.appendChild(toast);

        let successCount = 0;
        let failCount    = 0;

        await Promise.all(keys.map(async (key) => {
            const [id, collectionName] = key.split('|');
            try {
                await deleteDoc(doc(firestore, collectionName, id));
                successCount++;
                if (typeof adminLogger !== 'undefined') {
                    adminLogger.log('bulk_delete_record', 'History', id, { collection: collectionName });
                }
            } catch (err) {
                console.error(`[HistoryManager] Failed to delete ${collectionName}/${id}:`, err);
                failCount++;
            }
        }));

        // Remove successfully deleted items from local cache
        keys.forEach(key => {
            const [id, collectionName] = key.split('|');
            this.allHistory      = this.allHistory.filter(h => !(h.id === id && h.collection === collectionName));
            this.filteredHistory = this.filteredHistory.filter(h => !(h.id === id && h.collection === collectionName));
        });

        this.selectedItems.clear();
        this.calculatePagination();
        this.renderTable();
        this.renderPagination();
        this.updateStats();
        this.updateBulkToolbar();

        // Final toast
        if (failCount === 0) {
            toast.style.background = '#059669';
            toast.innerHTML = `<i class="fas fa-check-circle"></i> ${successCount} record${successCount > 1 ? 's' : ''} deleted successfully`;
        } else {
            toast.style.background = '#d97706';
            toast.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${successCount} deleted, ${failCount} failed`;
        }
        setTimeout(() => { if (toast.parentNode) document.body.removeChild(toast); }, 4000);
    }

    /**
     * confirmDelete — shows a styled modal before deleting a single record.
     */
    confirmDelete(id, collectionName, label) {
        const modal = document.getElementById('deleteConfirmModal');
        if (!modal) {
            if (confirm(`⚠️ DELETE this ${label}?\n\nThis is PERMANENT and cannot be undone.\nRecord ID: ${id}`)) {
                this.deleteRecord(id, collectionName);
            }
            return;
        }

        const titleEl    = document.getElementById('deleteModalTitle');
        const subtitleEl = document.getElementById('deleteModalSubtitle');
        const infoEl     = document.getElementById('deleteRecordInfo');
        const confirmBtn = document.getElementById('deleteConfirmBtn');
        const cancelBtn  = document.getElementById('deleteCancelBtn');

        if (titleEl)    titleEl.textContent = 'Delete History Record?';
        if (subtitleEl) subtitleEl.innerHTML = 'This action is <strong>permanent</strong> and cannot be undone.';
        if (infoEl)     infoEl.textContent = `${label} — ID: ${id} (${collectionName})`;

        if (confirmBtn) {
            const newBtn = confirmBtn.cloneNode(true);
            confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
            newBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                this.deleteRecord(id, collectionName);
            });
        }
        if (cancelBtn) cancelBtn.onclick = () => { modal.style.display = 'none'; };

        modal.style.display = 'flex';
    }

    /**
     * deleteRecord — permanently removes a record from Firestore (Admin only).
     */
    async deleteRecord(id, collectionName) {
        const toast = document.createElement('div');
        toast.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;
            background:#1e40af;color:#fff;padding:12px 20px;border-radius:8px;
            font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
        toast.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting record…';
        document.body.appendChild(toast);

        try {
            await deleteDoc(doc(firestore, collectionName, id));

            if (typeof adminLogger !== 'undefined') {
                adminLogger.log('delete_history_record', 'History', id, { collection: collectionName });
            }

            // Remove from local cache — no full reload needed
            this.allHistory      = this.allHistory.filter(h => !(h.id === id && h.collection === collectionName));
            this.filteredHistory = this.filteredHistory.filter(h => !(h.id === id && h.collection === collectionName));
            this.calculatePagination();
            this.renderTable();
            this.renderPagination();
            this.updateStats();

            toast.style.background = '#059669';
            toast.innerHTML = '<i class="fas fa-check-circle"></i> Record deleted successfully';
        } catch (error) {
            console.error('[HistoryManager] Delete error:', error);
            toast.style.background = '#ef4444';
            toast.innerHTML = `<i class="fas fa-times-circle"></i> Failed to delete: ${error.message}`;
        }
        setTimeout(() => { if (toast.parentNode) document.body.removeChild(toast); }, 3000);
    }
}

// Initialize when DOM is loaded
let historyManagerInstance = null;

document.addEventListener('DOMContentLoaded', () => {
    historyManagerInstance = new HistoryManager();
    
    // Make refresh available globally
    window.refreshHistoryData = () => {
        if (historyManagerInstance) {
            historyManagerInstance.refreshData();
        }
    };
});

export { HistoryManager };