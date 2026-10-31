/**
 * CLINICAL CARE PORTAL (PROTOTYPE) - FRONTEND APPLICATION
 * 
 * Implements:
 * - Role selection interface (Doctor, Nurse, Administrator)
 * - Prototype demo credentials & evaluator mismatch tester
 * - Strict separation of role selection vs server-side authorization
 * - Dedicated dashboards for Doctor, Nurse, and Administrator
 * - Role-switching restriction (explicit logout required)
 * - Synthetic clinical data interactions & audit logging
 */

(function () {
  'use strict';

  // App State
  const state = {
    selectedRole: 'DOCTOR', // default selected role on login screen
    currentUser: null,
    token: localStorage.getItem('clinic_auth_token') || null,
    activeTab: null,
    patients: [],
    selectedPatientId: null,
    nurseTasks: []
  };

  // DOM Elements - Auth Screen
  const authScreen = document.getElementById('authScreen');
  const roleCards = document.querySelectorAll('.role-card');
  const loginForm = document.getElementById('loginForm');
  const inputUsername = document.getElementById('inputUsername');
  const inputPassword = document.getElementById('inputPassword');
  const authAlert = document.getElementById('authAlert');
  const authAlertMessage = document.getElementById('authAlertMessage');

  // Demo Quick-Fill Buttons
  const btnFillDoctor = document.getElementById('btnFillDoctor');
  const btnFillNurse = document.getElementById('btnFillNurse');
  const btnFillAdmin = document.getElementById('btnFillAdmin');
  const btnTestMismatch = document.getElementById('btnTestMismatch');

  // Header Elements
  const userNav = document.getElementById('userNav');
  const userRoleBadge = document.getElementById('userRoleBadge');
  const userNameDisplay = document.getElementById('userNameDisplay');
  const userStaffId = document.getElementById('userStaffId');
  const btnLogout = document.getElementById('btnLogout');
  const headerLogo = document.getElementById('headerLogo');

  // Dashboards
  const doctorDashboard = document.getElementById('doctorDashboard');
  const nurseDashboard = document.getElementById('nurseDashboard');
  const adminDashboard = document.getElementById('adminDashboard');

  // Doctor Dashboard Elements
  const docSearchInput = document.getElementById('docSearchInput');
  const docPatientList = document.getElementById('docPatientList');
  const docChartTitle = document.getElementById('docChartTitle');
  const docChartActions = document.getElementById('docChartActions');
  const docChartBody = document.getElementById('docChartBody');
  const docTotalPatients = document.getElementById('docTotalPatients');
  const docFlaggedCount = document.getElementById('docFlaggedCount');
  const badgeFlaggedCount = document.getElementById('badgeFlaggedCount');
  const btnToggleFlag = document.getElementById('btnToggleFlag');

  // Nurse Dashboard Elements
  const nurseTasksTableBody = document.getElementById('nurseTasksTableBody');
  const nursePatientList = document.getElementById('nursePatientList');
  const nurseChartTitle = document.getElementById('nurseChartTitle');
  const nurseChartActions = document.getElementById('nurseChartActions');
  const nurseChartBody = document.getElementById('nurseChartBody');
  const nursePendingTasksCount = document.getElementById('nursePendingTasksCount');
  const nurseInpatientCount = document.getElementById('nurseInpatientCount');

  // Admin Dashboard Elements
  const adminUsersTableBody = document.getElementById('adminUsersTableBody');
  const adminAuditTableBody = document.getElementById('adminAuditTableBody');
  const adminSettingsList = document.getElementById('adminSettingsList');
  const adminDevicesTableBody = document.getElementById('adminDevicesTableBody');
  const adminSyncTableBody = document.getElementById('adminSyncTableBody');
  const adminTotalUsers = document.getElementById('adminTotalUsers');
  const adminAuditCount = document.getElementById('adminAuditCount');
  const syncPendingCount = document.getElementById('syncPendingCount');
  const syncSuccessCount = document.getElementById('syncSuccessCount');
  const btnTriggerManualSync = document.getElementById('btnTriggerManualSync');
  const btnRefreshAuditLogs = document.getElementById('btnRefreshAuditLogs');
  const auditFilterStatus = document.getElementById('auditFilterStatus');

  // Modals
  const modalDoctorConsult = document.getElementById('modalDoctorConsult');
  const formDoctorConsult = document.getElementById('formDoctorConsult');
  const modalDoctorMed = document.getElementById('modalDoctorMed');
  const formDoctorMed = document.getElementById('formDoctorMed');
  const modalNurseVitals = document.getElementById('modalNurseVitals');
  const formNurseVitals = document.getElementById('formNurseVitals');
  const modalNurseCareNote = document.getElementById('modalNurseCareNote');
  const formNurseCareNote = document.getElementById('formNurseCareNote');
  const modalAdminUser = document.getElementById('modalAdminUser');
  const formAdminUser = document.getElementById('formAdminUser');

  /* =========================================================================
     API HELPER
     ========================================================================= */
  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    if (state.token) {
      options.headers['Authorization'] = `Bearer ${state.token}`;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const response = await fetch(endpoint, options);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // If 401 Unauthorized, session expired or invalidated
      if (response.status === 401 && state.currentUser) {
        handleLogout(true);
        throw new Error('Your session has expired. Please log in again.');
      }
      const err = new Error(data.error || 'Server request failed');
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  /* =========================================================================
     ROLE SELECTION SCREEN LOGIC
     ========================================================================= */
  function selectRole(role) {
    state.selectedRole = role;
    roleCards.forEach(card => {
      if (card.dataset.role === role) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });
    hideAlert();
  }

  roleCards.forEach(card => {
    card.addEventListener('click', () => {
      selectRole(card.dataset.role);
    });
  });

  // Pre-select Doctor on initial load
  selectRole('DOCTOR');

  function showAlert(message, type = 'danger') {
    authAlert.className = `alert-box visible alert-${type}`;
    authAlertMessage.innerHTML = message;
  }

  function hideAlert() {
    authAlert.className = 'alert-box';
    authAlertMessage.innerHTML = '';
  }

  // Evaluator Quick-Fill Buttons
  btnFillDoctor.addEventListener('click', () => {
    selectRole('DOCTOR');
    inputUsername.value = 'dr.sarah';
    inputPassword.value = 'DoctorPass2026!';
    showAlert('Pre-filled Doctor demo credentials. Click "Authenticate" to test.', 'warning');
  });

  btnFillNurse.addEventListener('click', () => {
    selectRole('NURSE');
    inputUsername.value = 'nurse.james';
    inputPassword.value = 'NursePass2026!';
    showAlert('Pre-filled Nurse demo credentials. Click "Authenticate" to test.', 'warning');
  });

  btnFillAdmin.addEventListener('click', () => {
    selectRole('ADMINISTRATOR');
    inputUsername.value = 'admin.elena';
    inputPassword.value = 'AdminPass2026!';
    showAlert('Pre-filled Administrator demo credentials. Click "Authenticate" to test.', 'warning');
  });

  // Role Mismatch Security Tester
  // Intentionally selects Nurse role while entering Doctor credentials to demonstrate backend RBAC verification!
  btnTestMismatch.addEventListener('click', () => {
    selectRole('NURSE');
    inputUsername.value = 'dr.sarah';
    inputPassword.value = 'DoctorPass2026!';
    showAlert(
      '<strong>Role Mismatch Test Armed:</strong> Doctor credentials entered with "Nurse" role selected. Click "Authenticate" to verify backend rejection.',
      'warning'
    );
  });

  /* =========================================================================
     LOGIN SUBMISSION & ROLE-BASED NAVIGATION
     ========================================================================= */
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const username = inputUsername.value.trim();
    const password = inputPassword.value;
    const selectedRole = state.selectedRole;

    if (!username || !password) {
      showAlert('Please enter both your staff username and password.');
      return;
    }

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: {
          username: username,
          password: password,
          selected_role: selectedRole
        }
      });

      // Authentication successful
      state.token = res.token;
      state.currentUser = res.user;
      localStorage.setItem('clinic_auth_token', res.token);

      // Open dashboard associated with authorized role
      openRoleDashboard(res.user.role);

    } catch (err) {
      if (err.data && err.data.code === 'ROLE_MISMATCH') {
        showAlert(`
          <strong>&#9888; Security Rejection (Role Mismatch):</strong><br>
          ${err.data.error}<br>
          <span style="font-size: 0.8rem; margin-top: 4px; display: inline-block;">
            Note: Role selection requests an interface, but server authorization enforces actual credentials.
          </span>
        `, 'danger');
      } else {
        showAlert(err.message || 'Login failed. Please verify your credentials and selected role.');
      }
    }
  });

  /* =========================================================================
     LOGOUT & ROLE SWITCHING
     ========================================================================= */
  async function handleLogout(silent = false) {
    if (state.token && !silent) {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {
        console.error('Logout error:', e);
      }
    }

    state.token = null;
    state.currentUser = null;
    state.selectedPatientId = null;
    localStorage.removeItem('clinic_auth_token');

    // Hide all dashboards
    doctorDashboard.style.display = 'none';
    nurseDashboard.style.display = 'none';
    adminDashboard.style.display = 'none';
    userNav.style.display = 'none';

    // Return to role selection login screen
    authScreen.style.display = 'block';
    inputPassword.value = '';
    showAlert('You have been logged out. Select your role and authenticate to log in again.', 'warning');
  }

  btnLogout.addEventListener('click', () => handleLogout(false));

  /* =========================================================================
     NAVIGATION & ROLE-BASED DASHBOARD ROUTING
     ========================================================================= */
  function openRoleDashboard(role) {
    authScreen.style.display = 'none';
    userNav.style.display = 'flex';

    userNameDisplay.textContent = state.currentUser.fullName;
    userStaffId.textContent = `(${state.currentUser.staffId})`;
    userRoleBadge.textContent = role;
    userRoleBadge.className = `role-tag ${role.toLowerCase()}`;

    // Update brand icon accent
    if (role === 'DOCTOR') {
      headerLogo.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      doctorDashboard.style.display = 'block';
      nurseDashboard.style.display = 'none';
      adminDashboard.style.display = 'none';
      initDoctorDashboard();
    } else if (role === 'NURSE') {
      headerLogo.style.background = 'linear-gradient(135deg, #2563eb, #3b82f6)';
      doctorDashboard.style.display = 'none';
      nurseDashboard.style.display = 'block';
      adminDashboard.style.display = 'none';
      initNurseDashboard();
    } else if (role === 'ADMINISTRATOR') {
      headerLogo.style.background = 'linear-gradient(135deg, #7c3aed, #8b5cf6)';
      doctorDashboard.style.display = 'none';
      nurseDashboard.style.display = 'none';
      adminDashboard.style.display = 'block';
      initAdminDashboard();
    }
  }

  /* =========================================================================
     DOCTOR DASHBOARD LOGIC
     ========================================================================= */
  async function initDoctorDashboard() {
    setupDoctorTabs();
    await loadDoctorPatients();
  }

  function setupDoctorTabs() {
    const tabs = doctorDashboard.querySelectorAll('.nav-tab-btn');
    tabs.forEach(tab => {
      tab.onclick = () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const filterFlag = tab.dataset.tab === 'doc-flags';
        renderDoctorPatients(state.patients, filterFlag);
      };
    });

    docSearchInput.oninput = (e) => {
      const q = e.target.value.toLowerCase();
      const filtered = state.patients.filter(p =>
        p.full_name.toLowerCase().includes(q) ||
        p.mrn.toLowerCase().includes(q) ||
        p.primary_diagnosis.toLowerCase().includes(q) ||
        (p.room_bed && p.room_bed.toLowerCase().includes(q))
      );
      renderDoctorPatients(filtered);
    };

    btnToggleFlag.onclick = async () => {
      if (!state.selectedPatientId) return;
      const patient = state.patients.find(p => p.id === state.selectedPatientId);
      const newFlag = patient.clinical_review_flag ? 0 : 1;
      try {
        await apiFetch(`/api/doctor/patients/${state.selectedPatientId}/flag`, {
          method: 'POST',
          body: { flag: newFlag }
        });
        await loadDoctorPatients();
        await loadDoctorPatientChart(state.selectedPatientId);
      } catch (err) {
        alert(err.message);
      }
    };

    document.getElementById('btnOpenNewConsultModal').onclick = () => {
      const p = state.patients.find(x => x.id === state.selectedPatientId);
      if (!p) return;
      document.getElementById('consultPatientName').value = `${p.full_name} (${p.mrn})`;
      document.getElementById('consultPatientId').value = p.id;
      document.getElementById('consultReviewFlag').checked = !!p.clinical_review_flag;
      openModal(modalDoctorConsult);
    };

    document.getElementById('btnOpenNewMedModal').onclick = () => {
      const p = state.patients.find(x => x.id === state.selectedPatientId);
      if (!p) return;
      document.getElementById('medPatientName').value = `${p.full_name} (${p.mrn})`;
      document.getElementById('medPatientId').value = p.id;
      openModal(modalDoctorMed);
    };
  }

  async function loadDoctorPatients() {
    try {
      const data = await apiFetch('/api/patients');
      state.patients = data.patients || [];
      docTotalPatients.textContent = state.patients.length;

      const flagged = state.patients.filter(p => p.clinical_review_flag === 1).length;
      docFlaggedCount.textContent = flagged;
      badgeFlaggedCount.textContent = flagged;

      renderDoctorPatients(state.patients);

      // If patient previously selected, reload chart; else select first
      if (state.patients.length > 0) {
        const idToSelect = state.selectedPatientId || state.patients[0].id;
        loadDoctorPatientChart(idToSelect);
      }
    } catch (err) {
      console.error('Error loading patients:', err);
    }
  }

  function renderDoctorPatients(patients, filterFlagOnly = false) {
    const list = filterFlagOnly ? patients.filter(p => p.clinical_review_flag === 1) : patients;
    docPatientList.innerHTML = '';

    if (list.length === 0) {
      docPatientList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">No matching patients found.</div>`;
      return;
    }

    list.forEach(p => {
      const item = document.createElement('div');
      item.className = `patient-item ${state.selectedPatientId === p.id ? 'active' : ''}`;
      item.innerHTML = `
        <div>
          <div class="patient-item-name">${p.full_name}</div>
          <div class="patient-item-sub">
            <span>MRN: ${p.mrn}</span>
            <span>&bull;</span>
            <span>${p.room_bed || 'Outpatient'}</span>
          </div>
          <div style="font-size: 0.75rem; color: #475569; margin-top: 4px;">
            ${p.primary_diagnosis}
          </div>
        </div>
        <div>
          ${p.clinical_review_flag ? '<span class="flag-badge">&#9873; Review</span>' : ''}
        </div>
      `;
      item.onclick = () => {
        document.querySelectorAll('.patient-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        loadDoctorPatientChart(p.id);
      };
      docPatientList.appendChild(item);
    });
  }

  async function loadDoctorPatientChart(patientId) {
    state.selectedPatientId = patientId;
    try {
      const data = await apiFetch(`/api/patients/${patientId}`);
      const p = data.patient;
      docChartTitle.textContent = `${p.full_name} — Medical Chart`;
      docChartActions.style.display = 'flex';
      btnToggleFlag.textContent = p.clinical_review_flag ? 'Clear Review Flag' : 'Flag For Review';
      btnToggleFlag.className = `btn-sm ${p.clinical_review_flag ? 'btn-outline' : 'btn-doctor'}`;

      let html = `
        <div class="chart-banner">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px;">
            <div>
              <div style="font-size: 1.15rem; font-weight: 700;">${p.full_name} <span class="badge badge-info">Synthetic Record</span></div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">
                MRN: <strong>${p.mrn}</strong> &bull; DOB: ${p.dob} &bull; Gender: ${p.gender} &bull; Blood Group: <strong>${p.blood_type}</strong>
              </div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">
                Assigned Unit: <strong>${p.room_bed || 'Observation'}</strong> &bull; Attending: ${p.assigned_doctor}
              </div>
            </div>
            <div>
              <span class="badge ${p.admission_status === 'INPATIENT' ? 'badge-success' : 'badge-warning'}">${p.admission_status}</span>
              ${p.clinical_review_flag ? '<span class="flag-badge" style="margin-left: 6px;">&#9873; Clinical Review Flagged</span>' : ''}
            </div>
          </div>
        </div>

        ${p.allergies ? `
          <div class="allergies-alert">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <strong>Critical Allergy Alert:</strong> ${p.allergies}
          </div>
        ` : ''}

        <div style="margin-bottom: 24px;">
          <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px; color: #1e293b;">Primary Diagnosis &amp; Clinical Notes</h4>
          <div style="background: #fafbfc; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px; font-size: 0.875rem;">
            <strong>Primary Diagnosis:</strong> ${p.primary_diagnosis}<br>
            <span style="color: var(--text-muted); font-size: 0.8rem;">${p.notes || 'No additional baseline notes recorded.'}</span>
          </div>
        </div>

        <!-- Consultations Timeline -->
        <div style="margin-bottom: 24px;">
          <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px; color: #1e293b;">Clinical Consultations &amp; Physician Notes</h4>
          ${data.consultations.length === 0 ? '<p style="font-size: 0.85rem; color: var(--text-muted);">No consultations recorded yet.</p>' : ''}
          ${data.consultations.map(c => `
            <div style="background: white; border: 1px solid var(--border-color); border-left: 4px solid var(--doctor-accent); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 6px;">
                <span><strong>${c.doctor_name}</strong></span>
                <span>${new Date(c.timestamp).toLocaleString()}</span>
              </div>
              <div style="font-size: 0.85rem; margin-bottom: 4px;"><strong>Presentation:</strong> ${c.chief_complaint}</div>
              <div style="font-size: 0.85rem; margin-bottom: 4px;"><strong>Assessment:</strong> ${c.assessment}</div>
              <div style="font-size: 0.85rem; color: #334155;"><strong>Treatment Plan:</strong> ${c.treatment_plan.replace(/\n/g, '<br>')}</div>
            </div>
          `).join('')}
        </div>

        <!-- Active Medication Orders -->
        <div>
          <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px; color: #1e293b;">Medication Orders</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>Medication</th>
                <th>Dosage</th>
                <th>Route</th>
                <th>Frequency</th>
                <th>Status</th>
                <th>Ordered At</th>
              </tr>
            </thead>
            <tbody>
              ${data.medications.length === 0 ? '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No medication orders active.</td></tr>' : ''}
              ${data.medications.map(m => `
                <tr>
                  <td><strong>${m.medication_name}</strong></td>
                  <td>${m.dosage}</td>
                  <td>${m.route}</td>
                  <td>${m.frequency}</td>
                  <td><span class="badge ${m.status === 'ACTIVE' ? 'badge-success' : 'badge-info'}">${m.status}</span></td>
                  <td>${new Date(m.ordered_at).toLocaleDateString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      docChartBody.innerHTML = html;
    } catch (err) {
      docChartBody.innerHTML = `<div style="color: var(--danger); padding: 20px;">Failed to load patient chart: ${err.message}</div>`;
    }
  }

  // Doctor Consult Form Submission
  formDoctorConsult.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      patient_id: document.getElementById('consultPatientId').value,
      chief_complaint: document.getElementById('consultChiefComplaint').value,
      assessment: document.getElementById('consultAssessment').value,
      treatment_plan: document.getElementById('consultPlan').value,
      clinical_review_flag: document.getElementById('consultReviewFlag').checked
    };

    try {
      await apiFetch('/api/doctor/consultations', {
        method: 'POST',
        body: payload
      });
      closeModals();
      formDoctorConsult.reset();
      await loadDoctorPatients();
      await loadDoctorPatientChart(payload.patient_id);
    } catch (err) {
      alert('Error saving consultation: ' + err.message);
    }
  });

  // Doctor Medication Order Submission
  formDoctorMed.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      patient_id: document.getElementById('medPatientId').value,
      medication_name: document.getElementById('medName').value,
      dosage: document.getElementById('medDosage').value,
      route: document.getElementById('medRoute').value,
      frequency: document.getElementById('medFrequency').value
    };

    try {
      await apiFetch('/api/doctor/medications', {
        method: 'POST',
        body: payload
      });
      closeModals();
      formDoctorMed.reset();
      await loadDoctorPatientChart(payload.patient_id);
      alert('Medication prescribed and queued to Nursing eMAR.');
    } catch (err) {
      alert('Error ordering medication: ' + err.message);
    }
  });

  /* =========================================================================
     NURSE DASHBOARD LOGIC
     ========================================================================= */
  async function initNurseDashboard() {
    setupNurseTabs();
    await loadNurseTasks();
    await loadNursePatients();
  }

  function setupNurseTabs() {
    const tabs = nurseDashboard.querySelectorAll('.nav-tab-btn');
    tabs.forEach(tab => {
      tab.onclick = () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isTasks = tab.dataset.nurseTab === 'nurse-tasks';
        document.getElementById('nurseTasksTab').style.display = isTasks ? 'block' : 'none';
        document.getElementById('nursePatientsTab').style.display = isTasks ? 'none' : 'grid';
      };
    });

    document.getElementById('btnOpenRecordVitalsModal').onclick = () => {
      const p = state.patients.find(x => x.id === state.selectedPatientId);
      if (!p) return;
      document.getElementById('vitalPatientName').value = `${p.full_name} (${p.room_bed || 'Bedside'})`;
      document.getElementById('vitalPatientId').value = p.id;
      openModal(modalNurseVitals);
    };

    document.getElementById('btnOpenUpdateCareModal').onclick = () => {
      const p = state.patients.find(x => x.id === state.selectedPatientId);
      if (!p) return;
      document.getElementById('careNotePatientName').value = `${p.full_name} (${p.mrn})`;
      document.getElementById('careNotePatientId').value = p.id;
      openModal(modalNurseCareNote);
    };
  }

  async function loadNurseTasks() {
    try {
      const data = await apiFetch('/api/nurse/tasks');
      state.nurseTasks = data.tasks || [];

      const pending = state.nurseTasks.filter(t => t.status === 'PENDING').length;
      nursePendingTasksCount.textContent = pending;

      nurseTasksTableBody.innerHTML = '';
      if (state.nurseTasks.length === 0) {
        nurseTasksTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No nursing tasks queued.</td></tr>';
        return;
      }

      state.nurseTasks.forEach(task => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>
            <span class="badge ${task.status === 'COMPLETED' ? 'badge-success' : 'badge-warning'}">
              ${task.status}
            </span>
          </td>
          <td>
            <strong>${task.patient_name}</strong><br>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${task.room_bed || 'Ward Unit'}</span>
          </td>
          <td><strong>${task.scheduled_time}</strong></td>
          <td>${task.description}</td>
          <td>
            ${task.allergies ? `<span class="badge badge-danger">${task.allergies}</span>` : '<span style="font-size: 0.8rem; color: var(--text-muted);">NKDA</span>'}
          </td>
          <td>
            ${task.status === 'PENDING' ? `
              <button class="btn-sm btn-nurse btn-complete-task" data-id="${task.id}">
                Administer &amp; Verify
              </button>
            ` : `<span style="font-size: 0.8rem; color: var(--text-muted);">${task.completed_by || 'Completed'}</span>`}
          </td>
        `;
        nurseTasksTableBody.appendChild(tr);
      });

      // Bind complete task buttons
      document.querySelectorAll('.btn-complete-task').forEach(btn => {
        btn.onclick = async () => {
          const taskId = btn.dataset.id;
          const note = prompt('Enter administration verification notes:', 'Administered per five-rights protocol. Patient tolerated without adverse effect.');
          if (note === null) return;
          try {
            await apiFetch(`/api/nurse/tasks/${taskId}/complete`, {
              method: 'POST',
              body: { notes: note }
            });
            await loadNurseTasks();
          } catch (err) {
            alert(err.message);
          }
        };
      });
    } catch (err) {
      console.error('Error loading nursing tasks:', err);
    }
  }

  async function loadNursePatients() {
    try {
      const data = await apiFetch('/api/patients');
      state.patients = data.patients || [];
      nurseInpatientCount.textContent = state.patients.filter(p => p.admission_status === 'INPATIENT').length;

      nursePatientList.innerHTML = '';
      state.patients.forEach(p => {
        const item = document.createElement('div');
        item.className = `patient-item ${state.selectedPatientId === p.id ? 'active' : ''}`;
        item.innerHTML = `
          <div>
            <div class="patient-item-name">${p.full_name}</div>
            <div class="patient-item-sub">
              <span>${p.room_bed || 'Observation'}</span>
              <span>&bull;</span>
              <span>${p.admission_status}</span>
            </div>
          </div>
          <div>
            ${p.allergies ? '<span class="badge badge-danger">Allergies</span>' : ''}
          </div>
        `;
        item.onclick = () => {
          document.querySelectorAll('#nursePatientList .patient-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          loadNursePatientChart(p.id);
        };
        nursePatientList.appendChild(item);
      });

      if (state.patients.length > 0) {
        loadNursePatientChart(state.patients[0].id);
      }
    } catch (err) {
      console.error('Error loading nurse patients:', err);
    }
  }

  async function loadNursePatientChart(patientId) {
    state.selectedPatientId = patientId;
    try {
      const data = await apiFetch(`/api/patients/${patientId}`);
      const p = data.patient;
      nurseChartTitle.textContent = `${p.full_name} — Nursing Observations & Care Record`;
      nurseChartActions.style.display = 'flex';

      let html = `
        <div class="chart-banner">
          <div style="font-size: 1.1rem; font-weight: 700;">${p.full_name} &bull; ${p.room_bed}</div>
          <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">
            MRN: ${p.mrn} &bull; Primary: ${p.primary_diagnosis} &bull; Attending: ${p.assigned_doctor}
          </div>
        </div>

        ${p.allergies ? `
          <div class="allergies-alert">
            <strong>Allergy Warning:</strong> ${p.allergies}
          </div>
        ` : ''}

        <div style="margin-bottom: 20px;">
          <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px;">Care Plan &amp; Nursing Shift Records</h4>
          <div style="background: #fafbfc; border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px; font-size: 0.85rem; white-space: pre-line;">
            ${p.notes || 'No nursing shift notes recorded.'}
          </div>
        </div>

        <div>
          <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 8px;">Recorded Vital Signs &amp; Intake/Output</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>BP (mmHg)</th>
                <th>HR (BPM)</th>
                <th>RR</th>
                <th>SpO2</th>
                <th>Temp</th>
                <th>Intake / Output</th>
                <th>Recorded By</th>
              </tr>
            </thead>
            <tbody>
              ${data.observations.length === 0 ? '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No vitals logged yet.</td></tr>' : ''}
              ${data.observations.map(o => `
                <tr>
                  <td>${new Date(o.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  <td><strong>${o.bp_systolic}/${o.bp_diastolic}</strong></td>
                  <td>${o.heart_rate}</td>
                  <td>${o.respiratory_rate}</td>
                  <td>${o.spo2}%</td>
                  <td>${o.temperature_c}&deg;C</td>
                  <td>${o.intake_ml}mL / ${o.output_ml}mL</td>
                  <td>${o.nurse_name}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      nurseChartBody.innerHTML = html;
    } catch (err) {
      nurseChartBody.innerHTML = `<div style="color: var(--danger); padding: 20px;">Error: ${err.message}</div>`;
    }
  }

  // Nurse Vitals Form
  formNurseVitals.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      patient_id: document.getElementById('vitalPatientId').value,
      bp_systolic: document.getElementById('vitalBpSys').value,
      bp_diastolic: document.getElementById('vitalBpDia').value,
      heart_rate: document.getElementById('vitalHr').value,
      respiratory_rate: document.getElementById('vitalRr').value,
      temperature_c: document.getElementById('vitalTemp').value,
      spo2: document.getElementById('vitalSpo2').value,
      intake_ml: document.getElementById('vitalIntake').value,
      output_ml: document.getElementById('vitalOutput').value,
      observation_notes: document.getElementById('vitalNotes').value
    };

    try {
      await apiFetch('/api/nurse/observations', {
        method: 'POST',
        body: payload
      });
      closeModals();
      formNurseVitals.reset();
      await loadNursePatientChart(payload.patient_id);
    } catch (err) {
      alert('Error recording vitals: ' + err.message);
    }
  });

  // Nurse Progress Care Note Form
  formNurseCareNote.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patientId = document.getElementById('careNotePatientId').value;
    const care_notes = document.getElementById('careNoteText').value;

    try {
      await apiFetch(`/api/nurse/patients/${patientId}/notes`, {
        method: 'POST',
        body: { care_notes }
      });
      closeModals();
      formNurseCareNote.reset();
      await loadNursePatientChart(patientId);
    } catch (err) {
      alert('Error updating care note: ' + err.message);
    }
  });

  /* =========================================================================
     ADMINISTRATOR DASHBOARD LOGIC
     ========================================================================= */
  async function initAdminDashboard() {
    setupAdminTabs();
    await loadAdminUsers();
    await loadAdminAuditLogs();
  }

  function setupAdminTabs() {
    const tabs = adminDashboard.querySelectorAll('.nav-tab-btn');
    const contents = adminDashboard.querySelectorAll('.admin-tab-content');

    tabs.forEach(tab => {
      tab.onclick = async () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.adminTab;

        contents.forEach(c => c.style.display = 'none');
        if (target === 'admin-users') {
          document.getElementById('adminTabUsers').style.display = 'block';
          await loadAdminUsers();
        } else if (target === 'admin-roles') {
          document.getElementById('adminTabRoles').style.display = 'block';
        } else if (target === 'admin-settings') {
          document.getElementById('adminTabSettings').style.display = 'block';
          await loadAdminSettings();
        } else if (target === 'admin-devices') {
          document.getElementById('adminTabDevices').style.display = 'block';
          await loadAdminDevices();
        } else if (target === 'admin-sync') {
          document.getElementById('adminTabSync').style.display = 'block';
          await loadAdminSync();
        } else if (target === 'admin-audit') {
          document.getElementById('adminTabAudit').style.display = 'block';
          await loadAdminAuditLogs();
        }
      };
    });

    document.getElementById('btnOpenNewUserModal').onclick = () => {
      openModal(modalAdminUser);
    };

    btnRefreshAuditLogs.onclick = () => loadAdminAuditLogs();
    auditFilterStatus.onchange = () => loadAdminAuditLogs();

    btnTriggerManualSync.onclick = async () => {
      try {
        const res = await apiFetch('/api/admin/sync-now', { method: 'POST' });
        alert(res.message);
        await loadAdminSync();
      } catch (err) {
        alert(err.message);
      }
    };
  }

  async function loadAdminUsers() {
    try {
      const data = await apiFetch('/api/admin/users');
      const users = data.users || [];
      adminTotalUsers.textContent = users.length;

      adminUsersTableBody.innerHTML = '';
      users.forEach(u => {
        const tr = document.createElement('tr');
        const roleColor = u.authorized_role === 'DOCTOR' ? 'badge-success' : (u.authorized_role === 'NURSE' ? 'badge-info' : 'badge-purple');
        tr.innerHTML = `
          <td><strong>${u.username}</strong></td>
          <td>${u.full_name}</td>
          <td><span class="badge ${roleColor}">${u.authorized_role}</span></td>
          <td><code>${u.staff_id}</code></td>
          <td><span class="badge ${u.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}">${u.status}</span></td>
          <td>
            <button class="btn-sm btn-outline btn-toggle-user" data-id="${u.id}">
              ${u.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
            </button>
          </td>
        `;
        adminUsersTableBody.appendChild(tr);
      });

      document.querySelectorAll('.btn-toggle-user').forEach(btn => {
        btn.onclick = async () => {
          const userId = btn.dataset.id;
          try {
            await apiFetch(`/api/admin/users/${userId}/toggle-status`, { method: 'POST' });
            await loadAdminUsers();
          } catch (err) {
            alert(err.message);
          }
        };
      });
    } catch (err) {
      console.error('Error loading users:', err);
    }
  }

  // Create Staff User Form
  formAdminUser.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      authorized_role: document.getElementById('newUserRole').value,
      full_name: document.getElementById('newUserName').value,
      username: document.getElementById('newUserUsername').value,
      staff_id: document.getElementById('newUserStaffId').value,
      password: document.getElementById('newUserPassword').value
    };

    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: payload
      });
      closeModals();
      formAdminUser.reset();
      await loadAdminUsers();
      alert('New staff member added and authorized role configured.');
    } catch (err) {
      alert('Error creating staff user: ' + err.message);
    }
  });

  async function loadAdminSettings() {
    try {
      const data = await apiFetch('/api/admin/clinic-settings');
      adminSettingsList.innerHTML = '';
      data.settings.forEach(s => {
        const div = document.createElement('div');
        div.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-color);';
        div.innerHTML = `
          <div>
            <strong style="font-size: 0.9rem;">${s.key}</strong>
            <div style="font-size: 0.75rem; color: var(--text-muted);">Category: ${s.category} &bull; Last updated: ${new Date(s.updated_at).toLocaleString()}</div>
          </div>
          <div style="display: flex; gap: 8px;">
            <input type="text" class="form-input" value="${s.value}" id="setting_${s.key}" style="width: 260px;">
            <button class="btn-sm btn-admin btn-save-setting" data-key="${s.key}">Save</button>
          </div>
        `;
        adminSettingsList.appendChild(div);
      });

      document.querySelectorAll('.btn-save-setting').forEach(btn => {
        btn.onclick = async () => {
          const key = btn.dataset.key;
          const val = document.getElementById(`setting_${key}`).value;
          try {
            await apiFetch('/api/admin/clinic-settings', {
              method: 'PUT',
              body: { key, value: val }
            });
            alert(`Setting "${key}" updated.`);
          } catch (err) {
            alert(err.message);
          }
        };
      });
    } catch (err) {
      console.error('Error loading settings:', err);
    }
  }

  async function loadAdminDevices() {
    try {
      const data = await apiFetch('/api/admin/devices');
      adminDevicesTableBody.innerHTML = '';
      data.devices.forEach(d => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${d.device_name}</strong></td>
          <td>${d.device_type}</td>
          <td>${d.assigned_station}</td>
          <td><code>${d.ip_address}</code></td>
          <td><span class="badge badge-success">${d.sync_health}</span></td>
          <td>${new Date(d.last_sync_time).toLocaleTimeString()}</td>
        `;
        adminDevicesTableBody.appendChild(tr);
      });
    } catch (err) {
      console.error('Error loading devices:', err);
    }
  }

  async function loadAdminSync() {
    try {
      const data = await apiFetch('/api/admin/sync-status');
      syncPendingCount.textContent = data.pendingChangesCount;
      syncSuccessCount.textContent = data.syncedChangesCount;

      adminSyncTableBody.innerHTML = '';
      if (!data.recentQueue || data.recentQueue.length === 0) {
        adminSyncTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">Queue is clear. All offline changes synchronized.</td></tr>';
        return;
      }

      data.recentQueue.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${item.entity_type}</strong></td>
          <td>${item.change_type}</td>
          <td><span class="badge ${item.status === 'SYNCED' ? 'badge-success' : 'badge-warning'}">${item.status}</span></td>
          <td>${new Date(item.created_at).toLocaleTimeString()}</td>
          <td>${item.synced_at ? new Date(item.synced_at).toLocaleTimeString() : 'Pending'}</td>
        `;
        adminSyncTableBody.appendChild(tr);
      });
    } catch (err) {
      console.error('Error loading sync status:', err);
    }
  }

  async function loadAdminAuditLogs() {
    try {
      const status = auditFilterStatus.value;
      const url = status ? `/api/admin/audit-logs?status=${status}` : '/api/admin/audit-logs';
      const data = await apiFetch(url);
      const logs = data.logs || [];
      adminAuditCount.textContent = logs.length;

      adminAuditTableBody.innerHTML = '';
      if (logs.length === 0) {
        adminAuditTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No audit events recorded for current filter.</td></tr>';
        return;
      }

      logs.forEach(log => {
        const tr = document.createElement('tr');
        let statusBadge = 'badge-info';
        if (log.status === 'ALLOWED') statusBadge = 'badge-success';
        if (log.status === 'DENIED') statusBadge = 'badge-danger';
        if (log.status === 'MISMATCH') statusBadge = 'badge-warning';

        tr.innerHTML = `
          <td style="font-size: 0.75rem; white-space: nowrap;">${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
          <td><strong>${log.username}</strong></td>
          <td><span class="role-tag ${log.role ? log.role.toLowerCase() : ''}" style="font-size: 0.65rem;">${log.role}</span></td>
          <td><code>${log.action}</code></td>
          <td style="font-size: 0.8rem; color: var(--text-muted);">${log.resource}</td>
          <td><span class="badge ${statusBadge}">${log.status}</span></td>
          <td style="font-size: 0.8rem;">${log.details}</td>
        `;
        adminAuditTableBody.appendChild(tr);
      });
    } catch (err) {
      console.error('Error loading audit logs:', err);
    }
  }

  /* =========================================================================
     MODAL CONTROLS
     ========================================================================= */
  function openModal(modal) {
    modal.classList.add('open');
  }

  function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
  }

  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.onclick = closeModals;
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      closeModals();
    }
  });

  /* =========================================================================
     INITIAL SESSION RESTORATION CHECK
     ========================================================================= */
  async function checkInitialSession() {
    if (!state.token) return;
    try {
      const res = await apiFetch('/api/auth/me');
      state.currentUser = res.user;
      openRoleDashboard(res.user.role);
    } catch (err) {
      // Token invalid or expired, reset
      handleLogout(true);
    }
  }

  checkInitialSession();

})();
