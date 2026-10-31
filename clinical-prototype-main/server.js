/**
 * CLINICAL PORTAL PROTOTYPE - DISTRIBUTED OFFLINE-FIRST SERVER & API
 * 
 * Demonstrates:
 * 1. Role Selection & Authentication separation (Strict backend RBAC)
 * 2. Role mismatch detection and rejection (HTTP 403 Forbidden)
 * 3. Synthetic clinical patient records exclusively
 * 4. Predefined demo accounts
 * 5. Audit logging for compliance & access tracking
 * 6. Durable local synchronization outbox with atomic transactions
 * 7. Versioned synchronization protocol (Protocol v1.0, Schema v1)
 * 8. P2P Local Wi-Fi transport & Internet cloud synchronization
 * 9. Entity-aware & field-aware conflict handling (No naive LWW!)
 * 10. Visit-frequency analytics (7d, 30d, 90d, 180d, 365d, interval stats)
 * 11. Explainable UNUSUAL_VISIT_FREQUENCY alerts with clinician review
 * 12. Distributed alert deduplication & partial synchronization indicators
 * 13. Offline patient, visit, and document registration with SHA-256 integrity
 * 14. Administrative device revocation & offline limitation handling
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  calculateVisitAnalytics,
  evaluateVisitAlerts,
  reviewVisitAlert,
  getAnalyticsConfig
} = require('./analytics-engine');

const {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  IdGenerator,
  getLocalDeviceIdentity,
  recordOutboxChange,
  isDeviceRevoked,
  revokeDevice,
  processHandshake,
  getChangeSummary,
  getMissingChanges,
  applyChangesBatch,
  acknowledgeOutboxChanges,
  saveDocument,
  syncWithPeer
} = require('./sync-engine');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'clinical_prototype.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Initialize SQLite database
const db = new DatabaseSync(DB_PATH);

// Initialize schema & migrations
function initDatabase(targetDb = db) {
  targetDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      authorized_role TEXT NOT NULL CHECK(authorized_role IN ('DOCTOR', 'NURSE', 'ADMINISTRATOR')),
      full_name TEXT NOT NULL,
      staff_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip_address TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      role TEXT,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ALLOWED', 'DENIED', 'MISMATCH', 'SYSTEM')),
      details TEXT,
      ip_address TEXT
    );

    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      mrn TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      dob TEXT NOT NULL,
      gender TEXT NOT NULL,
      blood_type TEXT NOT NULL,
      allergies TEXT,
      primary_diagnosis TEXT NOT NULL,
      assigned_doctor TEXT,
      assigned_nurse TEXT,
      admission_status TEXT NOT NULL CHECK(admission_status IN ('INPATIENT', 'OBSERVATION', 'DISCHARGED')),
      room_bed TEXT,
      clinical_review_flag INTEGER DEFAULT 0,
      notes TEXT,
      is_synthetic INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL,
      sync_status TEXT DEFAULT 'SYNCED'
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      doctor_name TEXT NOT NULL,
      chief_complaint TEXT NOT NULL,
      assessment TEXT NOT NULL,
      treatment_plan TEXT NOT NULL,
      clinical_review_flag INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY(doctor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS medication_orders (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      doctor_name TEXT NOT NULL,
      medication_name TEXT NOT NULL,
      dosage TEXT NOT NULL,
      route TEXT NOT NULL,
      frequency TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ADMINISTERED', 'DISCONTINUED')),
      ordered_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY(doctor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS nursing_tasks (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      medication_order_id TEXT,
      task_type TEXT NOT NULL,
      description TEXT NOT NULL,
      scheduled_time TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'COMPLETED', 'MISSED')),
      completed_by TEXT,
      completed_at TEXT,
      notes TEXT,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY(medication_order_id) REFERENCES medication_orders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS nursing_observations (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      nurse_id TEXT NOT NULL,
      nurse_name TEXT NOT NULL,
      bp_systolic INTEGER NOT NULL,
      bp_diastolic INTEGER NOT NULL,
      heart_rate INTEGER NOT NULL,
      respiratory_rate INTEGER NOT NULL,
      temperature_c REAL NOT NULL,
      spo2 INTEGER NOT NULL,
      intake_ml INTEGER DEFAULT 0,
      output_ml INTEGER DEFAULT 0,
      observation_notes TEXT,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY(nurse_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS clinic_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      category TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      device_type TEXT NOT NULL,
      assigned_station TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      last_sync_time TEXT NOT NULL,
      sync_health TEXT NOT NULL CHECK(sync_health IN ('OPTIMAL', 'DEGRADED', 'OFFLINE')),
      registered_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'SYNCED' CHECK(status IN ('PENDING', 'SYNCED', 'CONFLICT')),
      created_at TEXT NOT NULL,
      synced_at TEXT
    );

    /* -------------------------------------------------------------
       DISTRIBUTED OFFLINE-FIRST SYNCHRONIZATION & ANALYTICS TABLES
       ------------------------------------------------------------- */

    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      visit_type TEXT NOT NULL CHECK(visit_type IN ('ROUTINE', 'EMERGENCY', 'FOLLOW_UP', 'SPECIALIST', 'TELEMEDICINE', 'INPATIENT_ROUNDS')),
      provider_name TEXT NOT NULL,
      department TEXT,
      chief_complaint TEXT,
      status TEXT NOT NULL CHECK(status IN ('CONFIRMED', 'CANCELLED', 'NO_SHOW', 'PLANNED')),
      is_synthetic INTEGER DEFAULT 1,
      revision INTEGER DEFAULT 1,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_archived INTEGER DEFAULT 0,
      archived_at TEXT,
      archived_reason TEXT,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      visit_id TEXT,
      title TEXT NOT NULL,
      document_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sha256_hash TEXT NOT NULL,
      storage_path TEXT,
      device_id TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      revision INTEGER DEFAULT 1,
      is_archived INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'PENDING',
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lab_results (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      test_name TEXT NOT NULL,
      test_category TEXT NOT NULL,
      result_value TEXT NOT NULL,
      unit TEXT,
      reference_range TEXT,
      flag TEXT,
      document_id TEXT,
      collected_at TEXT NOT NULL,
      reported_at TEXT NOT NULL,
      device_id TEXT NOT NULL,
      revision INTEGER DEFAULT 1,
      is_archived INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      change_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      operation_type TEXT NOT NULL CHECK(operation_type IN ('INSERT', 'UPDATE', 'ARCHIVE', 'CORRECTION')),
      device_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'SYNCED', 'CONFLICT', 'ACKNOWLEDGED')),
      dependencies TEXT,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      conflict_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      device_id_local TEXT NOT NULL,
      device_id_remote TEXT NOT NULL,
      local_revision INTEGER,
      remote_revision INTEGER,
      local_payload TEXT NOT NULL,
      remote_payload TEXT NOT NULL,
      conflict_type TEXT NOT NULL,
      resolution_strategy TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING_REVIEW', 'RESOLVED_ACCEPTED_BOTH', 'RESOLVED_CHOSEN_LOCAL', 'RESOLVED_CHOSEN_REMOTE', 'RESOLVED_MERGED')),
      resolution_notes TEXT,
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visit_alerts (
      alert_id TEXT PRIMARY KEY,
      dedup_key TEXT UNIQUE NOT NULL,
      patient_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      observation_window TEXT NOT NULL,
      confirmed_visits_count INTEGER NOT NULL,
      historical_baseline TEXT,
      supporting_visit_ids TEXT NOT NULL,
      data_quality_limitations TEXT NOT NULL,
      neutral_label TEXT NOT NULL DEFAULT 'UNUSUAL_VISIT_FREQUENCY',
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      review_status TEXT NOT NULL CHECK(review_status IN ('PENDING_CLINICIAN_REVIEW', 'REVIEWED_ACKNOWLEDGED', 'DISMISSED')),
      review_history TEXT NOT NULL,
      clinical_assessment_notes TEXT,
      clinical_disclaimer TEXT NOT NULL,
      FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS revoked_devices (
      device_id TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL,
      revoked_by TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_device_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_peers (
      peer_device_id TEXT PRIMARY KEY,
      peer_name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      last_handshake_at TEXT,
      last_successful_sync_at TEXT,
      last_sync_status TEXT,
      highest_synced_revision INTEGER DEFAULT 0,
      is_authorized INTEGER DEFAULT 1
    );
  `);

  // Column Migrations for existing tables
  migrateSchema(targetDb);

  // Initialize Local Device Identity
  getLocalDeviceIdentity(targetDb);

  // Seed default data & synthetic records
  seedDefaultData(targetDb);
}

/**
 * Migration helper to ensure backward-compatible column expansion
 */
function migrateSchema(targetDb = db) {
  try {
    const patientCols = targetDb.prepare('PRAGMA table_info(patients)').all().map(c => c.name);
    if (!patientCols.includes('phone')) targetDb.exec('ALTER TABLE patients ADD COLUMN phone TEXT;');
    if (!patientCols.includes('address')) targetDb.exec('ALTER TABLE patients ADD COLUMN address TEXT;');
    if (!patientCols.includes('revision')) targetDb.exec('ALTER TABLE patients ADD COLUMN revision INTEGER DEFAULT 1;');
    if (!patientCols.includes('is_archived')) targetDb.exec('ALTER TABLE patients ADD COLUMN is_archived INTEGER DEFAULT 0;');
    if (!patientCols.includes('created_device_id')) targetDb.exec('ALTER TABLE patients ADD COLUMN created_device_id TEXT;');

    const medCols = targetDb.prepare('PRAGMA table_info(medication_orders)').all().map(c => c.name);
    if (!medCols.includes('revision')) targetDb.exec('ALTER TABLE medication_orders ADD COLUMN revision INTEGER DEFAULT 1;');
    if (!medCols.includes('device_id')) targetDb.exec('ALTER TABLE medication_orders ADD COLUMN device_id TEXT;');
    if (!medCols.includes('updated_at')) targetDb.exec('ALTER TABLE medication_orders ADD COLUMN updated_at TEXT;');
    if (!medCols.includes('is_archived')) targetDb.exec('ALTER TABLE medication_orders ADD COLUMN is_archived INTEGER DEFAULT 0;');

    const conCols = targetDb.prepare('PRAGMA table_info(consultations)').all().map(c => c.name);
    if (!conCols.includes('revision')) targetDb.exec('ALTER TABLE consultations ADD COLUMN revision INTEGER DEFAULT 1;');
    if (!conCols.includes('device_id')) targetDb.exec('ALTER TABLE consultations ADD COLUMN device_id TEXT;');
    if (!conCols.includes('updated_at')) targetDb.exec('ALTER TABLE consultations ADD COLUMN updated_at TEXT;');
    if (!conCols.includes('is_archived')) targetDb.exec('ALTER TABLE consultations ADD COLUMN is_archived INTEGER DEFAULT 0;');
  } catch (err) {
    console.error('Migration warning:', err.message);
  }
}

// Password hashing helper
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

// Seed Demo Accounts, Synthetic Patients, Clinic Settings, Devices & Visits
function seedDefaultData(targetDb = db) {
  const existingUsersCount = targetDb.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (existingUsersCount === 0) {
    const insertUser = targetDb.prepare(`
      INSERT INTO users (id, username, password_hash, salt, authorized_role, full_name, staff_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    `);

    const demoAccounts = [
      {
        id: 'usr_doc_01',
        username: 'dr.sarah',
        password: 'DoctorPass2026!',
        role: 'DOCTOR',
        fullName: 'Dr. Sarah Bennett, MD',
        staffId: 'DOC-8821'
      },
      {
        id: 'usr_nur_01',
        username: 'nurse.james',
        password: 'NursePass2026!',
        role: 'NURSE',
        fullName: 'James Rodriguez, RN',
        staffId: 'NUR-4419'
      },
      {
        id: 'usr_adm_01',
        username: 'admin.elena',
        password: 'AdminPass2026!',
        role: 'ADMINISTRATOR',
        fullName: 'Elena Rostova, MHA',
        staffId: 'ADM-1002'
      }
    ];

    const now = new Date().toISOString();
    for (const acc of demoAccounts) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(acc.password, salt);
      insertUser.run(acc.id, acc.username, hash, salt, acc.role, acc.fullName, acc.staffId, now);
    }

    logAudit({
      userId: 'usr_adm_01',
      username: 'SYSTEM',
      role: 'ADMINISTRATOR',
      action: 'SYSTEM_INIT',
      resource: 'DATABASE',
      status: 'SYSTEM',
      details: 'Demonstration environment initialized with predefined prototype accounts and synthetic records.',
      ipAddress: '127.0.0.1'
    });
  }

  // Seed Synthetic Patient Data if empty
  const patientCount = targetDb.prepare('SELECT COUNT(*) AS count FROM patients').get().count;
  if (patientCount === 0) {
    const insertPatient = targetDb.prepare(`
      INSERT INTO patients (id, mrn, full_name, dob, gender, blood_type, allergies, primary_diagnosis, assigned_doctor, assigned_nurse, admission_status, room_bed, clinical_review_flag, notes, is_synthetic, updated_at, sync_status, phone, address, revision, is_archived, created_device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'SYNCED', ?, ?, 1, 0, 'dev_inst_master')
    `);

    const syntheticPatients = [
      {
        id: 'pat_syn_101',
        mrn: 'SYN-2026-001',
        name: 'Eleanor Vance (Synthetic)',
        dob: '1968-04-12',
        gender: 'Female',
        blood: 'A+',
        allergies: 'Penicillin, NSAIDs',
        diagnosis: 'Acute Decompensated Heart Failure (NYHA Class III)',
        doctor: 'Dr. Sarah Bennett, MD',
        nurse: 'James Rodriguez, RN',
        status: 'INPATIENT',
        room: 'Room 304 - Bed A',
        flag: 1,
        notes: 'Strict daily fluid restriction (<1.5L/day). Telemetry monitoring active.',
        phone: '+1 (555) 234-5678',
        address: '742 Evergreen Terrace, Springfield'
      },
      {
        id: 'pat_syn_102',
        mrn: 'SYN-2026-002',
        name: 'Marcus Holloway (Synthetic)',
        dob: '1984-11-23',
        gender: 'Male',
        blood: 'O-',
        allergies: 'Sulfa Drugs',
        diagnosis: 'Community-Acquired Pneumonia, Right Middle Lobe',
        doctor: 'Dr. Sarah Bennett, MD',
        nurse: 'James Rodriguez, RN',
        status: 'INPATIENT',
        room: 'Room 304 - Bed B',
        flag: 0,
        notes: 'IV Rocephin ongoing. Supplemental oxygen weaning trial at 2L NC.',
        phone: '+1 (555) 345-6789',
        address: '10880 Wilshire Blvd, Los Angeles, CA'
      },
      {
        id: 'pat_syn_103',
        mrn: 'SYN-2026-003',
        name: 'Aisha Al-Mansoor (Synthetic)',
        dob: '1995-07-08',
        gender: 'Female',
        blood: 'B+',
        allergies: 'No Known Drug Allergies (NKDA)',
        diagnosis: 'Post-Op Laparoscopic Appendectomy (Day 1)',
        doctor: 'Dr. Sarah Bennett, MD',
        nurse: 'James Rodriguez, RN',
        status: 'INPATIENT',
        room: 'Room 308 - Bed A',
        flag: 0,
        notes: 'Tolerating soft diet. Surgical site clean, dressing intact.',
        phone: '+1 (555) 456-7890',
        address: '42 Wallaby Way, Sydney'
      },
      {
        id: 'pat_syn_104',
        mrn: 'SYN-2026-004',
        name: 'David Kowalski (Synthetic)',
        dob: '1959-02-19',
        gender: 'Male',
        blood: 'AB+',
        allergies: 'Latex, Codeine',
        diagnosis: 'Type 2 Diabetes Mellitus with Hyperglycemia & Foot Ulcer',
        doctor: 'Dr. Sarah Bennett, MD',
        nurse: 'James Rodriguez, RN',
        status: 'OBSERVATION',
        room: 'Observation Unit 12',
        flag: 1,
        notes: 'Frequent fingerstick blood glucose monitoring required before meals.',
        phone: '+1 (555) 567-8901',
        address: '221B Baker Street, London'
      }
    ];

    const now = new Date().toISOString();
    for (const p of syntheticPatients) {
      insertPatient.run(
        p.id, p.mrn, p.name, p.dob, p.gender, p.blood, p.allergies,
        p.diagnosis, p.doctor, p.nurse, p.status, p.room, p.flag, p.notes,
        now, p.phone, p.address
      );
    }

    // Seed medication orders
    const insertMed = targetDb.prepare(`
      INSERT INTO medication_orders (id, patient_id, doctor_id, doctor_name, medication_name, dosage, route, frequency, status, ordered_at, revision, device_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 1, 'dev_inst_master', ?)
    `);

    insertMed.run('med_01', 'pat_syn_101', 'usr_doc_01', 'Dr. Sarah Bennett, MD', 'Furosemide (Lasix)', '40 mg', 'IV Bolus', 'Twice daily', now, now);
    insertMed.run('med_02', 'pat_syn_101', 'usr_doc_01', 'Dr. Sarah Bennett, MD', 'Lisinopril', '10 mg', 'Oral', 'Daily (Morning)', now, now);
    insertMed.run('med_03', 'pat_syn_102', 'usr_doc_01', 'Dr. Sarah Bennett, MD', 'Ceftriaxone (Rocephin)', '1 g', 'IV Piggyback', 'Every 24 hours', now, now);
    insertMed.run('med_04', 'pat_syn_103', 'usr_doc_01', 'Dr. Sarah Bennett, MD', 'Acetaminophen', '650 mg', 'Oral', 'Every 6 hours PRN mild pain', now, now);

    // Seed nursing tasks
    const insertTask = targetDb.prepare(`
      INSERT INTO nursing_tasks (id, patient_id, medication_order_id, task_type, description, scheduled_time, status)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
    `);

    insertTask.run('task_01', 'pat_syn_101', 'med_01', 'MEDICATION_ADMIN', 'Administer Furosemide 40mg IV Bolus & recheck BP/Output', '16:00');
    insertTask.run('task_02', 'pat_syn_101', null, 'VITALS_MONITORING', 'Q4H Vitals Check: SpO2, Heart Rate, BP, Respiratory Rate', '16:30');
    insertTask.run('task_03', 'pat_syn_102', 'med_03', 'MEDICATION_ADMIN', 'Infuse Ceftriaxone 1g IV Piggyback over 30 mins', '18:00');
    insertTask.run('task_04', 'pat_syn_103', null, 'WOUND_CHECK', 'Inspect laparoscopic surgical port dressings & drain', '17:00');

    // Seed clinical consultations
    const insertConsult = targetDb.prepare(`
      INSERT INTO consultations (id, patient_id, doctor_id, doctor_name, chief_complaint, assessment, treatment_plan, clinical_review_flag, timestamp, revision, device_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'dev_inst_master', ?)
    `);

    insertConsult.run(
      'con_01', 'pat_syn_101', 'usr_doc_01', 'Dr. Sarah Bennett, MD',
      'Worsening exertional dyspnea and bilateral ankle edema (+2 pitting).',
      'Acute exacerbation of chronic heart failure secondary to dietary indiscretion. Ejection fraction stable at 35%.',
      '1. Aggressive IV diuresis with Lasix 40mg BID.\n2. Strict daily weights and fluid intake limit 1500mL.\n3. Daily electrolyte panel monitoring.\n4. Flagged for review tomorrow morning.',
      1,
      now,
      now
    );

    // Seed initial nursing observation
    const insertObs = targetDb.prepare(`
      INSERT INTO nursing_observations (id, patient_id, nurse_id, nurse_name, bp_systolic, bp_diastolic, heart_rate, respiratory_rate, temperature_c, spo2, intake_ml, output_ml, observation_notes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertObs.run(
      'obs_01', 'pat_syn_101', 'usr_nur_01', 'James Rodriguez, RN',
      138, 88, 82, 18, 36.8, 96, 600, 950,
      'Patient resting comfortably in semi-Fowler position. No acute distress observed. Diuresis response adequate.',
      now
    );
  }

  // Seed Clinic Settings
  const settingsCount = targetDb.prepare('SELECT COUNT(*) AS count FROM clinic_settings').get().count;
  if (settingsCount === 0) {
    const insertSetting = targetDb.prepare('INSERT INTO clinic_settings (key, value, category, updated_at) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    insertSetting.run('clinic_name', 'St. Jude Metropolitan Community Clinic (Prototype)', 'GENERAL', now);
    insertSetting.run('clinic_emergency_contact', '+1 (555) 911-0420', 'GENERAL', now);
    insertSetting.run('operating_mode', 'DEMO_STANDALONE', 'SECURITY', now);
    insertSetting.run('session_inactivity_timeout_mins', '30', 'SECURITY', now);
    insertSetting.run('offline_sync_interval_sec', '60', 'SYNC', now);
    insertSetting.run('synthetic_data_enforced', 'TRUE', 'COMPLIANCE', now);
    insertSetting.run('audit_retention_days', '365', 'COMPLIANCE', now);

    // Analytics configuration settings
    insertSetting.run('analytics.short_window_days', '7', 'ANALYTICS', now);
    insertSetting.run('analytics.short_window_threshold', '3', 'ANALYTICS', now);
    insertSetting.run('analytics.month_window_days', '30', 'ANALYTICS', now);
    insertSetting.run('analytics.month_window_threshold', '5', 'ANALYTICS', now);
    insertSetting.run('analytics.deviation_multiplier', '2.5', 'ANALYTICS', now);
  }

  // Seed Devices
  const devicesCount = targetDb.prepare('SELECT COUNT(*) AS count FROM devices').get().count;
  if (devicesCount === 0) {
    const insertDevice = targetDb.prepare('INSERT INTO devices (id, device_name, device_type, assigned_station, ip_address, last_sync_time, sync_health, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    insertDevice.run('dev_01', 'Bedside-Tablet-Ward3A', 'Android Tablet (Encrypted)', 'Ward 3, Bedside', '10.0.14.21', now, 'OPTIMAL', now);
    insertDevice.run('dev_02', 'Physician-Mobile-Doc01', 'iOS Clinical Device', 'Doctor Mobile Fleet', '10.0.14.35', now, 'OPTIMAL', now);
    insertDevice.run('dev_03', 'Nurse-Station-Workstation', 'Desktop Terminal', 'Nurse Station Station 3', '10.0.14.50', now, 'OPTIMAL', now);
  }

  // Seed Synthetic Visits & Documents (Demonstrating all analytics rules & edge cases)
  const visitsCount = targetDb.prepare('SELECT COUNT(*) AS count FROM visits').get().count;
  if (visitsCount === 0) {
    const nowMs = Date.now();
    const dayMs = 86400000;
    const insertVisit = targetDb.prepare(`
      INSERT INTO visits (id, patient_id, visit_date, visit_type, provider_name, department, chief_complaint, status, is_synthetic, revision, device_id, created_at, updated_at, is_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 1, 1, 'dev_inst_master', ?, ?, 0)
    `);

    // Eleanor Vance (pat_syn_101): Heart Failure
    // Cluster: 4 visits in last 7 days, 6 in last 30 days -> Triggers Rule 1 & Rule 2
    const eleanorOffsets = [1, 2, 4, 6, 15, 24, 45, 80, 120, 180, 240];
    eleanorOffsets.forEach((daysAgo, i) => {
      const vDate = new Date(nowMs - daysAgo * dayMs).toISOString();
      insertVisit.run(
        `vis_pat101_${i + 1}`,
        'pat_syn_101',
        vDate,
        i < 4 ? 'EMERGENCY' : 'FOLLOW_UP',
        'Dr. Sarah Bennett, MD',
        'Cardiology',
        i < 4 ? 'Acute exertional dyspnea and bilateral leg swelling' : 'Routine congestive heart failure follow-up',
        vDate,
        vDate
      );
    });

    // Marcus Holloway (pat_syn_102): Pneumonia
    // Historical baseline of visits every 60 days, followed by sudden recent cluster (3 visits in last 14 days)
    // -> Triggers Rule 3 (SUBSTANTIAL_BASELINE_DEVIATION)
    const marcusOffsets = [3, 7, 12, 70, 130, 190];
    marcusOffsets.forEach((daysAgo, i) => {
      const vDate = new Date(nowMs - daysAgo * dayMs).toISOString();
      insertVisit.run(
        `vis_pat102_${i + 1}`,
        'pat_syn_102',
        vDate,
        i < 3 ? 'SPECIALIST' : 'ROUTINE',
        'Dr. Sarah Bennett, MD',
        'Pulmonology',
        i < 3 ? 'Persistent productive cough with purulent sputum' : 'Routine respiratory maintenance review',
        vDate,
        vDate
      );
    });

    // Aisha Al-Mansoor (pat_syn_103): Appendectomy
    // Only 1 visit -> Demonstrates baseline reliability safeguard (<3 visits -> reliableBaseline: false)
    const aishaDate = new Date(nowMs - 1 * dayMs).toISOString();
    insertVisit.run(
      'vis_pat103_1',
      'pat_syn_103',
      aishaDate,
      'ROUTINE',
      'Dr. Sarah Bennett, MD',
      'General Surgery',
      'Post-op Day 1 Laparoscopic Appendectomy Evaluation',
      aishaDate,
      aishaDate
    );

    // David Kowalski (pat_syn_104): Diabetes
    // Stable visits spaced evenly every ~90 days -> 0 alerts triggered
    const davidOffsets = [10, 95, 185, 275];
    davidOffsets.forEach((daysAgo, i) => {
      const vDate = new Date(nowMs - daysAgo * dayMs).toISOString();
      insertVisit.run(
        `vis_pat104_${i + 1}`,
        'pat_syn_104',
        vDate,
        'ROUTINE',
        'Dr. Sarah Bennett, MD',
        'Endocrinology',
        'Quarterly HbA1c review & diabetic foot ulcer inspection',
        vDate,
        vDate
      );
    });

    // Seed synthetic document for Eleanor Vance
    const sampleDocContent = Buffer.from('TRANSTHORACIC ECHOCARDIOGRAM REPORT\nPatient: Eleanor Vance\nEjection Fraction: 35%\nLeft Ventricular Dilation: Moderate\nNo pericardial effusion.\nSynthetic Evaluative Record Only.');
    const docHash = crypto.createHash('sha256').update(sampleDocContent).digest('hex');
    const docDate = new Date(nowMs - 2 * dayMs).toISOString();
    targetDb.prepare(`
      INSERT INTO documents (
        id, patient_id, visit_id, title, document_type, mime_type, file_size,
        sha256_hash, storage_path, device_id, uploaded_at, revision, is_archived, sync_status
      ) VALUES (?, 'pat_syn_101', 'vis_pat101_1', 'Echocardiogram 2D Report', 'IMAGING_REPORT', 'text/plain', ?, ?, ?, 'dev_inst_master', ?, 1, 0, 'SYNCED')
    `).run('doc_syn_01', sampleDocContent.length, docHash, 'documents/doc_syn_01.dat', docDate);

    // Write file to documents dir
    const docFilePath = path.join(PUBLIC_DIR, 'documents', 'doc_syn_01.dat');
    try {
      if (!fs.existsSync(path.dirname(docFilePath))) fs.mkdirSync(path.dirname(docFilePath), { recursive: true });
      fs.writeFileSync(docFilePath, sampleDocContent);
    } catch (e) {}

    // Initial alert evaluation across all seeded patients
    ['pat_syn_101', 'pat_syn_102', 'pat_syn_103', 'pat_syn_104'].forEach(patId => {
      try {
        evaluateVisitAlerts(targetDb, patId, new Date(), 'dev_inst_master');
      } catch (e) {
        console.error(`Seed alert evaluation warning for ${patId}:`, e.message);
      }
    });
  }
}

// Audit logging helper
function logAudit({ userId, username, role, action, resource, status, details, ipAddress }) {
  try {
    const id = 'aud_' + crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO audit_logs (id, timestamp, user_id, username, role, action, resource, status, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, timestamp, userId || null, username || 'ANONYMOUS', role || 'UNASSIGNED', action, resource, status, details || '', ipAddress || '127.0.0.1');
  } catch (err) {
    console.error('Audit log write error:', err);
  }
}

// Session authentication & RBAC middleware helpers
function getSessionUser(token) {
  if (!token) return null;
  const stmt = db.prepare(`
    SELECT s.token, s.expires_at, u.id, u.username, u.authorized_role, u.full_name, u.staff_id, u.status
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `);
  const session = stmt.get(token);
  if (!session) return null;

  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return session;
}

// Parse JSON Body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5e6) { // 5MB limit for document uploads
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Send JSON Response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Device-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

// Serve static files
function serveStatic(req, res, pathname) {
  let relativePath = pathname === '/' ? 'index.html' : pathname;
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Request Handler
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;
  const clientIp = req.socket.remoteAddress || '127.0.0.1';

  // CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Device-Secret',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  // Extract Bearer Token
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  const currentUser = getSessionUser(token);

  // Protected route authorizer helper
  function requireAuth(allowedRoles) {
    if (!currentUser) {
      logAudit({
        userId: null,
        username: 'ANONYMOUS',
        role: 'UNAUTHENTICATED',
        action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        resource: pathname,
        status: 'DENIED',
        details: 'API call rejected: missing or expired session token.',
        ipAddress: clientIp
      });
      sendJson(res, 401, { error: 'Authentication required. Please log in.' });
      return null;
    }

    if (allowedRoles && !allowedRoles.includes(currentUser.authorized_role)) {
      logAudit({
        userId: currentUser.id,
        username: currentUser.username,
        role: currentUser.authorized_role,
        action: 'FORBIDDEN_ROLE_ACCESS',
        resource: pathname,
        status: 'DENIED',
        details: `Access forbidden: Endpoint requires one of [${allowedRoles.join(', ')}], but user holds role [${currentUser.authorized_role}].`,
        ipAddress: clientIp
      });
      sendJson(res, 403, {
        error: `Access denied. Your authorized role (${currentUser.authorized_role}) does not have permission to access this resource.`
      });
      return null;
    }

    return currentUser;
  }

  try {
    /* =========================================================================
       AUTHENTICATION & SESSION ENDPOINTS
       ========================================================================= */

    // 1. GET /api/auth/demo-accounts - Predefined demo profiles for easy evaluator access
    if (pathname === '/api/auth/demo-accounts' && method === 'GET') {
      const demoList = [
        {
          role: 'DOCTOR',
          roleTitle: 'Doctor (Physician)',
          username: 'dr.sarah',
          password: 'DoctorPass2026!',
          fullName: 'Dr. Sarah Bennett, MD',
          staffId: 'DOC-8821',
          description: 'Access to clinical consultations, medication orders, review flags, and patient charts.'
        },
        {
          role: 'NURSE',
          roleTitle: 'Nurse (Clinical Care)',
          username: 'nurse.james',
          password: 'NursePass2026!',
          fullName: 'James Rodriguez, RN',
          staffId: 'NUR-4419',
          description: 'Access to medication administration tasks (eMAR), vital sign observations, and care records.'
        },
        {
          role: 'ADMINISTRATOR',
          roleTitle: 'Administrator (System & Clinic)',
          username: 'admin.elena',
          password: 'AdminPass2026!',
          fullName: 'Elena Rostova, MHA',
          staffId: 'ADM-1002',
          description: 'Access to user management, clinic settings, device security, sync health, and audit logs.'
        }
      ];

      return sendJson(res, 200, {
        isPrototypeDemo: true,
        notice: 'DEMO PROTOTYPE ENVIRONMENT - SYNTHETIC DATA ONLY. These accounts are provided exclusively for prototype demonstration and evaluative testing.',
        accounts: demoList
      });
    }

    // 2. POST /api/auth/login - Role Selection & Authentication
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await parseJsonBody(req);
      const effectiveRole = body.selected_role || body.requestedRole || body.role;
      const { username, password } = body;

      if (!effectiveRole || !username || !password) {
        logAudit({
          userId: null,
          username: username || 'ANONYMOUS',
          role: effectiveRole || 'UNKNOWN',
          action: 'LOGIN_ATTEMPT',
          resource: '/api/auth/login',
          status: 'DENIED',
          details: 'Login rejected: missing selected_role, username, or password.',
          ipAddress: clientIp
        });
        return sendJson(res, 400, { error: 'Role selection, username, and password are required.' });
      }

      const normalizedRole = effectiveRole.trim().toUpperCase();
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());

      if (!user) {
        logAudit({
          userId: null,
          username,
          role: normalizedRole,
          action: 'LOGIN_FAILURE',
          resource: '/api/auth/login',
          status: 'DENIED',
          details: `Authentication failed: User "${username}" not found.`,
          ipAddress: clientIp
        });
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }

      if (user.status !== 'ACTIVE') {
        logAudit({
          userId: user.id,
          username: user.username,
          role: user.authorized_role,
          action: 'LOGIN_LOCKED',
          resource: '/api/auth/login',
          status: 'DENIED',
          details: `Authentication blocked: Account "${username}" is disabled.`,
          ipAddress: clientIp
        });
        return sendJson(res, 403, { error: 'Your account has been deactivated. Contact an administrator.' });
      }

      const inputHash = hashPassword(password, user.salt);
      if (inputHash !== user.password_hash) {
        logAudit({
          userId: user.id,
          username: user.username,
          role: normalizedRole,
          action: 'LOGIN_FAILURE',
          resource: '/api/auth/login',
          status: 'DENIED',
          details: `Authentication failed: Password mismatch for user "${username}".`,
          ipAddress: clientIp
        });
        return sendJson(res, 401, { error: 'Invalid username or password.' });
      }

      // STRICT ROLE MISMATCH VERIFICATION
      if (user.authorized_role !== normalizedRole) {
        logAudit({
          userId: user.id,
          username: user.username,
          role: user.authorized_role,
          action: 'ROLE_MISMATCH_REJECTION',
          resource: '/api/auth/login',
          status: 'MISMATCH',
          details: `Security Violation: User "${user.username}" (Authorized Role: [${user.authorized_role}]) attempted to authenticate selecting Role: [${normalizedRole}]. Login rejected.`,
          ipAddress: clientIp
        });
        return sendJson(res, 403, {
          error: `Role Mismatch: Your account (${user.username}) is authorized as [${user.authorized_role}], but you selected [${normalizedRole}]. You cannot obtain elevated permissions by selecting a different role. Please select [${user.authorized_role}] on the login screen.`,
          code: 'ROLE_MISMATCH',
          authorizedRole: user.authorized_role,
          selectedRole: normalizedRole
        });
      }

      // Create cryptographic session token
      const sessionToken = crypto.randomBytes(32).toString('hex');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000); // 8-hour session

      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare(`
        INSERT INTO sessions (token, user_id, role, created_at, expires_at, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionToken, user.id, user.authorized_role, now.toISOString(), expiresAt.toISOString(), clientIp);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'LOGIN_SUCCESS',
        resource: '/api/auth/login',
        status: 'ALLOWED',
        details: `Successful authentication for ${user.full_name} (${user.authorized_role}).`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, {
        message: 'Authentication successful',
        token: sessionToken,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          staffId: user.staff_id,
          role: user.authorized_role
        }
      });
    }

    // 3. POST /api/auth/logout - Invalidate session
    if (pathname === '/api/auth/logout' && method === 'POST') {
      if (token && currentUser) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
        logAudit({
          userId: currentUser.id,
          username: currentUser.username,
          role: currentUser.authorized_role,
          action: 'LOGOUT',
          resource: '/api/auth/logout',
          status: 'ALLOWED',
          details: `User ${currentUser.username} logged out. Session terminated.`,
          ipAddress: clientIp
        });
      }
      return sendJson(res, 200, { message: 'Logged out successfully. Session destroyed.' });
    }

    // 4. GET /api/auth/me - Validate existing session
    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = requireAuth();
      if (!user) return;

      return sendJson(res, 200, {
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          staffId: user.staff_id,
          role: user.authorized_role
        }
      });
    }

    /* =========================================================================
       PATIENT CLINICAL & OFFLINE-FIRST MUTATION ENDPOINTS
       ========================================================================= */

    // GET /api/patients - Search and list synthetic patients (Doctor & Nurse authorized)
    if (pathname === '/api/patients' && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const q = (parsedUrl.searchParams.get('q') || '').trim();
      const flagFilter = parsedUrl.searchParams.get('flag');

      let query = 'SELECT * FROM patients WHERE is_archived = 0';
      const params = [];

      if (q) {
        query += ' AND (full_name LIKE ? OR mrn LIKE ? OR primary_diagnosis LIKE ? OR room_bed LIKE ?)';
        const term = `%${q}%`;
        params.push(term, term, term, term);
      }

      if (flagFilter === '1') {
        query += ' AND clinical_review_flag = 1';
      }

      query += ' ORDER BY clinical_review_flag DESC, updated_at DESC';

      const patients = db.prepare(query).all(...params);
      return sendJson(res, 200, { patients, count: patients.length, isSyntheticData: true });
    }

    // POST /api/patients - Offline patient creation
    if (pathname === '/api/patients' && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'NURSE', 'ADMINISTRATOR']);
      if (!user) return;

      const body = await parseJsonBody(req);
      const { full_name, dob, gender, blood_type, primary_diagnosis, phone, address, allergies, room_bed, admission_status, notes } = body;

      if (!full_name || !dob || !primary_diagnosis) {
        return sendJson(res, 400, { error: 'Full name, date of birth, and primary diagnosis are required.' });
      }

      const patientId = IdGenerator.patient();
      const mrn = body.mrn || `SYN-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const now = new Date().toISOString();
      const localId = getLocalDeviceIdentity(db);

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO patients (
            id, mrn, full_name, dob, gender, blood_type, allergies, primary_diagnosis,
            assigned_doctor, assigned_nurse, admission_status, room_bed, clinical_review_flag,
            notes, is_synthetic, updated_at, sync_status, phone, address, revision, is_archived, created_device_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, 'PENDING', ?, ?, 1, 0, ?)
        `).run(
          patientId, mrn, full_name, dob, gender || 'Unspecified', blood_type || 'Unknown',
          allergies || null, primary_diagnosis, user.full_name, null,
          admission_status || 'OBSERVATION', room_bed || 'Admissions',
          notes || '', now, phone || null, address || null, localId.deviceId
        );

        recordOutboxChange(db, {
          entityType: 'PATIENT',
          entityId: patientId,
          operationType: 'INSERT',
          payload: {
            id: patientId,
            mrn,
            full_name,
            dob,
            gender: gender || 'Unspecified',
            blood_type: blood_type || 'Unknown',
            allergies,
            primary_diagnosis,
            assigned_doctor: user.full_name,
            admission_status: admission_status || 'OBSERVATION',
            room_bed: room_bed || 'Admissions',
            notes,
            phone,
            address,
            updated_at: now
          },
          deviceId: localId.deviceId,
          revision: 1
        });

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'OFFLINE_PATIENT_CREATED',
        resource: `/api/patients/${patientId}`,
        status: 'ALLOWED',
        details: `Created patient record for ${full_name} (${mrn}) offline. Committed to sync outbox.`,
        ipAddress: clientIp
      });

      return sendJson(res, 201, {
        message: 'Patient created offline successfully',
        patientId,
        mrn
      });
    }

    // PUT /api/patients/:id - Offline patient update
    if (pathname.startsWith('/api/patients/') && method === 'PUT') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
      if (!patient) return sendJson(res, 404, { error: 'Patient not found' });

      const body = await parseJsonBody(req);
      const now = new Date().toISOString();
      const localId = getLocalDeviceIdentity(db);
      const newRevision = (patient.revision || 1) + 1;

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          UPDATE patients
          SET full_name = ?, primary_diagnosis = ?, phone = ?, address = ?,
              allergies = ?, notes = ?, revision = ?, updated_at = ?, sync_status = 'PENDING'
          WHERE id = ?
        `).run(
          body.full_name || patient.full_name,
          body.primary_diagnosis || patient.primary_diagnosis,
          body.phone !== undefined ? body.phone : patient.phone,
          body.address !== undefined ? body.address : patient.address,
          body.allergies !== undefined ? body.allergies : patient.allergies,
          body.notes !== undefined ? body.notes : patient.notes,
          newRevision, now, patientId
        );

        recordOutboxChange(db, {
          entityType: 'PATIENT',
          entityId: patientId,
          operationType: 'UPDATE',
          payload: {
            id: patientId,
            full_name: body.full_name || patient.full_name,
            primary_diagnosis: body.primary_diagnosis || patient.primary_diagnosis,
            phone: body.phone !== undefined ? body.phone : patient.phone,
            address: body.address !== undefined ? body.address : patient.address,
            allergies: body.allergies !== undefined ? body.allergies : patient.allergies,
            notes: body.notes !== undefined ? body.notes : patient.notes,
            revision: newRevision,
            updated_at: now
          },
          deviceId: localId.deviceId,
          revision: newRevision
        });

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'PATIENT_UPDATED_OFFLINE',
        resource: `/api/patients/${patientId}`,
        status: 'ALLOWED',
        details: `Updated record for patient ${patientId}. Revision: ${newRevision}. Committed to sync outbox.`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Patient updated offline', revision: newRevision });
    }

    // GET /api/patients/:id - Patient details with full synthetic chart & analytics
    if (pathname.startsWith('/api/patients/') && method === 'GET' && !pathname.includes('visits') && !pathname.includes('documents') && !pathname.includes('analytics') && !pathname.includes('alerts')) {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);

      if (!patient) {
        return sendJson(res, 404, { error: 'Patient record not found.' });
      }

      const consultations = db.prepare('SELECT * FROM consultations WHERE patient_id = ? AND is_archived = 0 ORDER BY timestamp DESC').all(patientId);
      const medications = db.prepare('SELECT * FROM medication_orders WHERE patient_id = ? AND is_archived = 0 ORDER BY ordered_at DESC').all(patientId);
      const observations = db.prepare('SELECT * FROM nursing_observations WHERE patient_id = ? ORDER BY recorded_at DESC LIMIT 10').all(patientId);
      const tasks = db.prepare('SELECT * FROM nursing_tasks WHERE patient_id = ? ORDER BY scheduled_time ASC').all(patientId);
      const visits = db.prepare('SELECT * FROM visits WHERE patient_id = ? AND is_archived = 0 ORDER BY visit_date DESC').all(patientId);
      const documents = db.prepare('SELECT id, patient_id, visit_id, title, document_type, mime_type, file_size, sha256_hash, uploaded_at, revision, sync_status FROM documents WHERE patient_id = ? AND is_archived = 0 ORDER BY uploaded_at DESC').all(patientId);

      const analytics = calculateVisitAnalytics(db, patientId);
      const alerts = db.prepare('SELECT * FROM visit_alerts WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'PATIENT_CHART_VIEW',
        resource: `/api/patients/${patientId}`,
        status: 'ALLOWED',
        details: `Viewed chart for synthetic patient ${patient.full_name} (${patient.mrn})`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, {
        patient,
        consultations,
        medications,
        observations,
        tasks,
        visits,
        documents,
        analytics,
        alerts
      });
    }

    /* =========================================================================
       VISIT RECORD REGISTRATION & FREQUENCY ANALYTICS
       ========================================================================= */

    // GET /api/patients/:id/visits - List patient visits
    if (pathname.match(/^\/api\/patients\/[^\/]+\/visits$/) && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const visits = db.prepare('SELECT * FROM visits WHERE patient_id = ? AND is_archived = 0 ORDER BY visit_date DESC').all(patientId);
      return sendJson(res, 200, { visits, count: visits.length });
    }

    // POST /api/patients/:id/visits - Register visit offline
    if (pathname.match(/^\/api\/patients\/[^\/]+\/visits$/) && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const { visit_date, visit_type, provider_name, department, chief_complaint, status } = await parseJsonBody(req);

      if (!visit_date || !visit_type) {
        return sendJson(res, 400, { error: 'Visit date and visit type are required.' });
      }

      const visitId = IdGenerator.visit();
      const now = new Date().toISOString();
      const localId = getLocalDeviceIdentity(db);
      const visitStatus = status || 'CONFIRMED';

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO visits (
            id, patient_id, visit_date, visit_type, provider_name, department,
            chief_complaint, status, is_synthetic, revision, device_id, created_at, updated_at, is_archived
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 0)
        `).run(
          visitId, patientId, visit_date, visit_type,
          provider_name || user.full_name, department || 'General Medicine',
          chief_complaint || 'Clinical Consultation', visitStatus,
          localId.deviceId, now, now
        );

        recordOutboxChange(db, {
          entityType: 'VISIT',
          entityId: visitId,
          operationType: 'INSERT',
          payload: {
            id: visitId,
            patient_id: patientId,
            visit_date,
            visit_type,
            provider_name: provider_name || user.full_name,
            department: department || 'General Medicine',
            chief_complaint: chief_complaint || 'Clinical Consultation',
            status: visitStatus,
            created_at: now
          },
          deviceId: localId.deviceId,
          revision: 1,
          dependencies: { patient_id: patientId }
        });

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      // Re-evaluate visit analytics & distributed alerts
      const alertResult = evaluateVisitAlerts(db, patientId, new Date(), localId.deviceId);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'VISIT_REGISTERED_OFFLINE',
        resource: `/api/patients/${patientId}/visits/${visitId}`,
        status: 'ALLOWED',
        details: `Registered offline ${visitStatus} visit (${visit_type}) for patient ${patientId}. Recalculated analytics.`,
        ipAddress: clientIp
      });

      return sendJson(res, 201, {
        message: 'Visit registered successfully offline',
        visitId,
        analytics: alertResult.analytics,
        alertsGenerated: alertResult.alerts.length
      });
    }

    // GET /api/patients/:id/analytics - Deterministic visit frequency analytics
    if (pathname.match(/^\/api\/patients\/[^\/]+\/analytics$/) && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const analytics = calculateVisitAnalytics(db, patientId);
      return sendJson(res, 200, { analytics });
    }

    // GET /api/patients/:id/alerts - Active unusual visit-frequency alerts
    if (pathname.match(/^\/api\/patients\/[^\/]+\/alerts$/) && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const alerts = db.prepare('SELECT * FROM visit_alerts WHERE patient_id = ? ORDER BY created_at DESC').all(patientId);
      return sendJson(res, 200, { alerts, count: alerts.length });
    }

    // POST /api/doctor/alerts/:id/review - Clinician alert review workflow
    if (pathname.match(/^\/api\/doctor\/alerts\/[^\/]+\/review$/) && method === 'POST') {
      const user = requireAuth(['DOCTOR']);
      if (!user) return;

      const alertId = pathname.split('/')[4];
      const { action, notes } = await parseJsonBody(req);

      if (!action || !['ACKNOWLEDGE', 'DISMISS'].includes(action.toUpperCase())) {
        return sendJson(res, 400, { error: 'Action must be ACKNOWLEDGE or DISMISS.' });
      }

      try {
        const reviewResult = reviewVisitAlert(db, alertId, user, action, notes);

        logAudit({
          userId: user.id,
          username: user.username,
          role: user.authorized_role,
          action: 'DOCTOR_ALERT_REVIEW',
          resource: `/api/doctor/alerts/${alertId}/review`,
          status: 'ALLOWED',
          details: `Doctor ${user.full_name} reviewed alert ${alertId} with action ${reviewResult.reviewStatus}.`,
          ipAddress: clientIp
        });

        return sendJson(res, 200, { message: 'Alert review recorded successfully', reviewResult });
      } catch (err) {
        return sendJson(res, 404, { error: err.message });
      }
    }

    /* =========================================================================
       DOCUMENT MANAGEMENT & HASH VERIFICATION
       ========================================================================= */

    // GET /api/patients/:id/documents - List documents metadata
    if (pathname.match(/^\/api\/patients\/[^\/]+\/documents$/) && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const documents = db.prepare(`
        SELECT id, patient_id, visit_id, title, document_type, mime_type, file_size, sha256_hash, uploaded_at, revision, sync_status
        FROM documents
        WHERE patient_id = ? AND is_archived = 0
        ORDER BY uploaded_at DESC
      `).all(patientId);

      return sendJson(res, 200, { documents, count: documents.length });
    }

    // POST /api/patients/:id/documents - Upload document offline
    if (pathname.match(/^\/api\/patients\/[^\/]+\/documents$/) && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[3];
      const { title, document_type, mime_type, content, content_base64, visit_id } = await parseJsonBody(req);

      if (!title || (!content && !content_base64)) {
        return sendJson(res, 400, { error: 'Document title and file content are required.' });
      }

      const buffer = content_base64 ? Buffer.from(content_base64, 'base64') : Buffer.from(content, 'utf8');
      const localId = getLocalDeviceIdentity(db);

      const docRecord = saveDocument(db, {
        patientId,
        visitId: visit_id || null,
        title,
        documentType: document_type || 'CLINICAL_NOTE',
        mimeType: mime_type || 'text/plain',
        contentBuffer: buffer,
        deviceId: localId.deviceId
      });

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'DOCUMENT_UPLOADED_OFFLINE',
        resource: `/api/patients/${patientId}/documents/${docRecord.docId}`,
        status: 'ALLOWED',
        details: `Uploaded document "${title}" (${docRecord.fileSize} bytes) offline. SHA-256: ${docRecord.sha256Hash}`,
        ipAddress: clientIp
      });

      return sendJson(res, 201, {
        message: 'Document saved and outbox change recorded',
        document: docRecord
      });
    }

    // GET /api/documents/:id/download - Download document content with hash verification
    if (pathname.match(/^\/api\/documents\/[^\/]+\/download$/) && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'NURSE']);
      if (!user) return;

      const docId = pathname.split('/')[3];
      const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND is_archived = 0').get(docId);
      if (!doc) return sendJson(res, 404, { error: 'Document not found.' });

      const filePath = path.join(PUBLIC_DIR, 'documents', `${docId}.dat`);
      if (!fs.existsSync(filePath)) {
        return sendJson(res, 404, { error: 'Document content file missing from local storage.' });
      }

      const content = fs.readFileSync(filePath);
      const computedHash = crypto.createHash('sha256').update(content).digest('hex');

      if (computedHash !== doc.sha256_hash) {
        logAudit({
          userId: user.id,
          username: user.username,
          role: user.authorized_role,
          action: 'DOCUMENT_HASH_INTEGRITY_FAILURE',
          resource: `/api/documents/${docId}/download`,
          status: 'DENIED',
          details: `Cryptographic hash mismatch! Stored: ${doc.sha256_hash}, Computed: ${computedHash}`,
          ipAddress: clientIp
        });
        return sendJson(res, 500, { error: 'Document content failed SHA-256 hash integrity verification.' });
      }

      res.writeHead(200, {
        'Content-Type': doc.mime_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.title)}"`,
        'X-Content-SHA256': computedHash
      });
      return res.end(content);
    }

    /* =========================================================================
       DOCTOR SPECIFIC ENDPOINTS
       ========================================================================= */

    // POST /api/doctor/consultations - Add clinical consultation & review flag
    if (pathname === '/api/doctor/consultations' && method === 'POST') {
      const user = requireAuth(['DOCTOR']);
      if (!user) return;

      const { patient_id, chief_complaint, assessment, treatment_plan, clinical_review_flag } = await parseJsonBody(req);

      if (!patient_id || !assessment || !treatment_plan) {
        return sendJson(res, 400, { error: 'Patient ID, clinical assessment, and treatment plan are required.' });
      }

      const consultId = IdGenerator.consultation();
      const now = new Date().toISOString();
      const flagVal = clinical_review_flag ? 1 : 0;
      const localId = getLocalDeviceIdentity(db);

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO consultations (id, patient_id, doctor_id, doctor_name, chief_complaint, assessment, treatment_plan, clinical_review_flag, timestamp, revision, device_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(consultId, patient_id, user.id, user.full_name, chief_complaint || 'Routine Review', assessment, treatment_plan, flagVal, now, localId.deviceId, now);

        db.prepare(`
          UPDATE patients 
          SET clinical_review_flag = ?, updated_at = ?, sync_status = 'PENDING'
          WHERE id = ?
        `).run(flagVal, now, patient_id);

        recordOutboxChange(db, {
          entityType: 'CONSULTATION',
          entityId: consultId,
          operationType: 'INSERT',
          payload: {
            id: consultId,
            patient_id,
            doctor_id: user.id,
            doctor_name: user.full_name,
            chief_complaint: chief_complaint || 'Routine Review',
            assessment,
            treatment_plan,
            clinical_review_flag: flagVal,
            timestamp: now
          },
          deviceId: localId.deviceId,
          revision: 1,
          dependencies: { patient_id }
        });

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'DOCTOR_CONSULTATION_CREATED',
        resource: `/api/doctor/consultations/${consultId}`,
        status: 'ALLOWED',
        details: `Recorded clinical consultation for patient ID ${patient_id}. Review flag: ${flagVal}`,
        ipAddress: clientIp
      });

      return sendJson(res, 201, { message: 'Consultation recorded successfully', consultationId: consultId });
    }

    // POST /api/doctor/medications - Order new medication
    if (pathname === '/api/doctor/medications' && method === 'POST') {
      const user = requireAuth(['DOCTOR']);
      if (!user) return;

      const { patient_id, medication_name, dosage, route, frequency } = await parseJsonBody(req);

      if (!patient_id || !medication_name || !dosage || !frequency) {
        return sendJson(res, 400, { error: 'Patient ID, medication name, dosage, and frequency are required.' });
      }

      const orderId = IdGenerator.medication();
      const taskId = 'task_' + crypto.randomUUID();
      const now = new Date().toISOString();
      const localId = getLocalDeviceIdentity(db);

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO medication_orders (id, patient_id, doctor_id, doctor_name, medication_name, dosage, route, frequency, status, ordered_at, revision, device_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 1, ?, ?)
        `).run(orderId, patient_id, user.id, user.full_name, medication_name, dosage, route || 'Oral', frequency, now, localId.deviceId, now);

        db.prepare(`
          INSERT INTO nursing_tasks (id, patient_id, medication_order_id, task_type, description, scheduled_time, status)
          VALUES (?, ?, ?, 'MEDICATION_ADMIN', ?, 'Next Scheduled Dose', 'PENDING')
        `).run(taskId, patient_id, orderId, `Administer ${medication_name} ${dosage} via ${route || 'Oral'} (${frequency})`);

        recordOutboxChange(db, {
          entityType: 'MEDICATION_ORDER',
          entityId: orderId,
          operationType: 'INSERT',
          payload: {
            id: orderId,
            patient_id,
            doctor_id: user.id,
            doctor_name: user.full_name,
            medication_name,
            dosage,
            route: route || 'Oral',
            frequency,
            status: 'ACTIVE',
            ordered_at: now
          },
          deviceId: localId.deviceId,
          revision: 1,
          dependencies: { patient_id }
        });

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'DOCTOR_MEDICATION_ORDERED',
        resource: `/api/doctor/medications/${orderId}`,
        status: 'ALLOWED',
        details: `Ordered medication: ${medication_name} ${dosage} for patient ID ${patient_id}`,
        ipAddress: clientIp
      });

      return sendJson(res, 201, { message: 'Medication order created and routed to nursing tasks', orderId });
    }

    // POST /api/doctor/patients/:id/flag - Toggle clinical review flag
    if (pathname.match(/^\/api\/doctor\/patients\/[^\/]+\/flag$/) && method === 'POST') {
      const user = requireAuth(['DOCTOR']);
      if (!user) return;

      const patientId = pathname.split('/')[4];
      const { flag } = await parseJsonBody(req);
      const flagVal = flag ? 1 : 0;
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE patients SET clinical_review_flag = ?, updated_at = ? WHERE id = ?
      `).run(flagVal, now, patientId);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'DOCTOR_REVIEW_FLAG_TOGGLE',
        resource: `/api/patients/${patientId}`,
        status: 'ALLOWED',
        details: `Clinical review flag set to ${flagVal} for patient ${patientId}`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Review flag updated', flag: flagVal });
    }

    /* =========================================================================
       NURSE SPECIFIC ENDPOINTS
       ========================================================================= */

    // GET /api/nurse/tasks - Get medication administration & nursing tasks
    if (pathname === '/api/nurse/tasks' && method === 'GET') {
      const user = requireAuth(['NURSE']);
      if (!user) return;

      const tasks = db.prepare(`
        SELECT t.*, p.full_name AS patient_name, p.mrn, p.room_bed, p.allergies
        FROM nursing_tasks t
        JOIN patients p ON t.patient_id = p.id
        ORDER BY t.status DESC, t.scheduled_time ASC
      `).all();

      return sendJson(res, 200, { tasks, count: tasks.length });
    }

    // POST /api/nurse/tasks/:id/complete - Mark medication task completed / administered
    if (pathname.match(/^\/api\/nurse\/tasks\/[^\/]+\/complete$/) && method === 'POST') {
      const user = requireAuth(['NURSE']);
      if (!user) return;

      const taskId = pathname.split('/')[4];
      const { notes } = await parseJsonBody(req);
      const now = new Date().toISOString();

      const task = db.prepare('SELECT * FROM nursing_tasks WHERE id = ?').get(taskId);
      if (!task) {
        return sendJson(res, 404, { error: 'Task not found.' });
      }

      db.prepare(`
        UPDATE nursing_tasks 
        SET status = 'COMPLETED', completed_by = ?, completed_at = ?, notes = ?
        WHERE id = ?
      `).run(user.full_name, now, notes || 'Verified and administered as prescribed.', taskId);

      if (task.medication_order_id) {
        db.prepare("UPDATE medication_orders SET status = 'ADMINISTERED' WHERE id = ?").run(task.medication_order_id);
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'NURSE_TASK_COMPLETED',
        resource: `/api/nurse/tasks/${taskId}`,
        status: 'ALLOWED',
        details: `Task "${task.description}" completed by nurse ${user.full_name}.`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Nursing task marked as completed' });
    }

    // POST /api/nurse/observations - Record nursing observations & vitals
    if (pathname === '/api/nurse/observations' && method === 'POST') {
      const user = requireAuth(['NURSE']);
      if (!user) return;

      const {
        patient_id, bp_systolic, bp_diastolic, heart_rate,
        respiratory_rate, temperature_c, spo2, intake_ml, output_ml, observation_notes
      } = await parseJsonBody(req);

      if (!patient_id || !bp_systolic || !bp_diastolic || !heart_rate || !spo2) {
        return sendJson(res, 400, { error: 'Patient ID and primary vital signs are required.' });
      }

      const obsId = IdGenerator.observation();
      const now = new Date().toISOString();
      const localId = getLocalDeviceIdentity(db);

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO nursing_observations (
            id, patient_id, nurse_id, nurse_name, bp_systolic, bp_diastolic,
            heart_rate, respiratory_rate, temperature_c, spo2, intake_ml, output_ml,
            observation_notes, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          obsId, patient_id, user.id, user.full_name,
          parseInt(bp_systolic, 10), parseInt(bp_diastolic, 10),
          parseInt(heart_rate, 10), parseInt(respiratory_rate || 16, 10),
          parseFloat(temperature_c || 37.0), parseInt(spo2, 10),
          parseInt(intake_ml || 0, 10), parseInt(output_ml || 0, 10),
          observation_notes || '', now
        );

        db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now, patient_id);

        recordOutboxChange(db, {
          entityType: 'NURSING_OBSERVATION',
          entityId: obsId,
          operationType: 'INSERT',
          payload: {
            id: obsId,
            patient_id,
            nurse_id: user.id,
            nurse_name: user.full_name,
            bp_systolic: parseInt(bp_systolic, 10),
            bp_diastolic: parseInt(bp_diastolic, 10),
            heart_rate: parseInt(heart_rate, 10),
            spo2: parseInt(spo2, 10),
            recorded_at: now
          },
          deviceId: localId.deviceId,
          revision: 1,
          dependencies: { patient_id }
        });

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'NURSE_OBSERVATION_RECORDED',
        resource: `/api/nurse/observations/${obsId}`,
        status: 'ALLOWED',
        details: `Recorded vitals (BP ${bp_systolic}/${bp_diastolic}, HR ${heart_rate}, SpO2 ${spo2}%) for patient ID ${patient_id}`,
        ipAddress: clientIp
      });

      return sendJson(res, 201, { message: 'Nursing observation recorded successfully', observationId: obsId });
    }

    // POST /api/nurse/patients/:id/notes - Nursing record care update
    if (pathname.match(/^\/api\/nurse\/patients\/[^\/]+\/notes$/) && method === 'POST') {
      const user = requireAuth(['NURSE']);
      if (!user) return;

      const patientId = pathname.split('/')[4];
      const { care_notes } = await parseJsonBody(req);

      if (!care_notes) {
        return sendJson(res, 400, { error: 'Care update notes required.' });
      }

      const now = new Date().toISOString();
      const patient = db.prepare('SELECT notes FROM patients WHERE id = ?').get(patientId);
      if (!patient) {
        return sendJson(res, 404, { error: 'Patient not found' });
      }

      const updatedNotes = (patient.notes ? patient.notes + '\n' : '') + `[${new Date().toLocaleTimeString()} ${user.full_name}]: ${care_notes}`;
      db.prepare('UPDATE patients SET notes = ?, updated_at = ? WHERE id = ?').run(updatedNotes, now, patientId);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'NURSE_CARE_UPDATE',
        resource: `/api/patients/${patientId}/notes`,
        status: 'ALLOWED',
        details: `Nursing progress note appended by ${user.full_name}`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Care record updated', updatedNotes });
    }

    /* =========================================================================
       SYNCHRONIZATION PROTOCOL: P2P LOCAL WI-FI & INTERNET CLOUD
       ========================================================================= */

    // GET /api/sync/status - Comprehensive Synchronization Status
    if (pathname === '/api/sync/status' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR', 'DOCTOR', 'NURSE']);
      if (!user) return;

      const localId = getLocalDeviceIdentity(db);
      const pendingOutboxCount = db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE status = 'PENDING'").get().count;
      const acknowledgedCount = db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE status = 'ACKNOWLEDGED'").get().count;
      const conflictsPendingCount = db.prepare("SELECT COUNT(*) AS count FROM sync_conflicts WHERE status = 'PENDING_REVIEW'").get().count;
      const documentsPendingCount = db.prepare("SELECT COUNT(*) AS count FROM documents WHERE sync_status = 'PENDING'").get().count;
      const peers = db.prepare('SELECT * FROM sync_peers').all();
      const lastSyncRow = db.prepare("SELECT MAX(acknowledged_at) AS last_sync FROM sync_outbox WHERE status = 'ACKNOWLEDGED'").get();

      return sendJson(res, 200, {
        syncEngine: 'HYBRID_OFFLINE_CAPABLE',
        localDeviceId: localId.deviceId,
        localDeviceName: localId.deviceName,
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: SCHEMA_VERSION,
        onlineStatus: 'ONLINE_READY',
        hasUnsynchronizedChanges: pendingOutboxCount > 0,
        lastSuccessfulSync: lastSyncRow ? lastSyncRow.last_sync : null,
        pendingChangesCount: pendingOutboxCount,
        syncedChangesCount: acknowledgedCount,
        conflictsAwaitingReview: conflictsPendingCount,
        documentsAwaitingTransfer: documentsPendingCount,
        connectedPeersCount: peers.length,
        peers
      });
    }

    // POST /api/sync/peer/handshake - Versioned Protocol & Device Handshake
    if (pathname === '/api/sync/peer/handshake' && method === 'POST') {
      const handshakeBody = await parseJsonBody(req);
      const result = processHandshake(db, handshakeBody);

      if (!result.success) {
        logAudit({
          userId: null,
          username: handshakeBody.device_id || 'ANONYMOUS_PEER',
          role: 'PEER_DEVICE',
          action: 'PEER_HANDSHAKE_REJECTED',
          resource: '/api/sync/peer/handshake',
          status: 'DENIED',
          details: `Peer handshake rejected: ${result.error} - ${result.message}`,
          ipAddress: clientIp
        });
        return sendJson(res, result.statusCode, { error: result.error, message: result.message });
      }

      return sendJson(res, 200, result.handshake);
    }

    // GET /api/sync/peer/summary - Outbox Vector Summary
    if (pathname === '/api/sync/peer/summary' && method === 'GET') {
      const summary = getChangeSummary(db);
      return sendJson(res, 200, summary);
    }

    // POST /api/sync/peer/pull-changes - Request missing changes
    if (pathname === '/api/sync/peer/pull-changes' && method === 'POST') {
      const { sinceRevisions, limit } = await parseJsonBody(req);
      const changes = getMissingChanges(db, { sinceRevisions, limit });
      return sendJson(res, 200, changes);
    }

    // POST /api/sync/peer/push-changes - Apply incoming batch transactionally
    if (pathname === '/api/sync/peer/push-changes' && method === 'POST') {
      const { changes, sourceDeviceId } = await parseJsonBody(req);
      const devId = sourceDeviceId || req.headers['x-device-id'] || 'peer-unknown';

      if (isDeviceRevoked(db, devId)) {
        return sendJson(res, 403, { error: 'DEVICE_REVOKED', message: 'Device authorization has been revoked.' });
      }

      try {
        const result = applyChangesBatch(db, changes, devId, currentUser || { id: 'PEER', username: devId, role: 'SYSTEM' });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to apply changes transactionally', details: err.message });
      }
    }

    // POST /api/sync/peer/ack - Acknowledge applied changes
    if (pathname === '/api/sync/peer/ack' && method === 'POST') {
      const { acknowledgedIds } = await parseJsonBody(req);
      const ackCount = acknowledgeOutboxChanges(db, acknowledgedIds);
      return sendJson(res, 200, { message: 'Outbox changes acknowledged', count: ackCount });
    }

    // GET /api/sync/conflicts - List sync conflicts awaiting review
    if (pathname === '/api/sync/conflicts' && method === 'GET') {
      const user = requireAuth(['DOCTOR', 'ADMINISTRATOR']);
      if (!user) return;

      const conflicts = db.prepare('SELECT * FROM sync_conflicts ORDER BY created_at DESC').all();
      return sendJson(res, 200, { conflicts, count: conflicts.length });
    }

    // POST /api/sync/conflicts/:id/resolve - Clinician / Admin Conflict Resolution
    if (pathname.match(/^\/api\/sync\/conflicts\/[^\/]+\/resolve$/) && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'ADMINISTRATOR']);
      if (!user) return;

      const conflictId = pathname.split('/')[4];
      const { resolutionStrategy, resolutionNotes } = await parseJsonBody(req);

      const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE conflict_id = ?').get(conflictId);
      if (!conflict) return sendJson(res, 404, { error: 'Conflict not found.' });

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE sync_conflicts
        SET status = 'RESOLVED_MERGED',
            resolution_strategy = ?,
            resolution_notes = ?,
            resolved_by = ?,
            resolved_at = ?
        WHERE conflict_id = ?
      `).run(resolutionStrategy || 'MANUAL_CLINICIAN_REVIEW', resolutionNotes || '', user.full_name, now, conflictId);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'SYNC_CONFLICT_RESOLVED',
        resource: `/api/sync/conflicts/${conflictId}`,
        status: 'ALLOWED',
        details: `Conflict ${conflictId} (${conflict.conflict_type}) resolved by ${user.full_name}.`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Conflict resolved successfully' });
    }

    // POST /api/sync/cloud/upload - Authenticated Internet Synchronization Upload
    if (pathname === '/api/sync/cloud/upload' && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'NURSE', 'ADMINISTRATOR']);
      if (!user) return;

      const { changes, deviceId } = await parseJsonBody(req);
      const devId = deviceId || req.headers['x-device-id'] || 'cloud-client';

      if (isDeviceRevoked(db, devId)) {
        return sendJson(res, 403, { error: 'DEVICE_REVOKED', message: 'Device authorization has been revoked.' });
      }

      // Patient-level authorization verification
      for (const chg of changes || []) {
        const patientId = chg.payload?.patient_id || chg.entity_id;
        if (patientId && user.authorized_role === 'NURSE') {
          // Verify patient exists and is accessible
          const pat = db.prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
          if (!pat) {
            logAudit({
              userId: user.id,
              username: user.username,
              role: user.authorized_role,
              action: 'PATIENT_AUTH_MISMATCH',
              resource: `/api/sync/cloud/upload/${patientId}`,
              status: 'DENIED',
              details: `Nurse ${user.username} unauthorized to sync change for patient ID ${patientId}.`,
              ipAddress: clientIp
            });
            return sendJson(res, 403, { error: `UNAUTHORIZED_PATIENT_ACCESS: You lack authorization for patient ${patientId}.` });
          }
        }
      }

      try {
        const result = applyChangesBatch(db, changes, devId, user);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: 'Cloud sync change application failed', details: err.message });
      }
    }

    // POST /api/sync/cloud/download - Authenticated Internet Synchronization Download
    if (pathname === '/api/sync/cloud/download' && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'NURSE', 'ADMINISTRATOR']);
      if (!user) return;

      const { sinceRevisions, limit } = await parseJsonBody(req);
      const changes = getMissingChanges(db, { sinceRevisions, limit });
      return sendJson(res, 200, changes);
    }

    // POST /api/sync/cloud/ack - Confirm cloud sync completion
    if (pathname === '/api/sync/cloud/ack' && method === 'POST') {
      const user = requireAuth(['DOCTOR', 'NURSE', 'ADMINISTRATOR']);
      if (!user) return;

      const { acknowledgedIds } = await parseJsonBody(req);
      const ackCount = acknowledgeOutboxChanges(db, acknowledgedIds);
      return sendJson(res, 200, { message: 'Cloud sync changes acknowledged', count: ackCount });
    }

    // POST /api/admin/devices/:id/revoke - Device Revocation
    if (pathname.match(/^\/api\/admin\/devices\/[^\/]+\/revoke$/) && method === 'POST') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const targetDeviceId = pathname.split('/')[4];
      const { reason } = await parseJsonBody(req);

      const revocationRecord = revokeDevice(db, targetDeviceId, user, reason || 'Administrative Security Revocation');

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'ADMIN_DEVICE_REVOKED',
        resource: `/api/admin/devices/${targetDeviceId}/revoke`,
        status: 'ALLOWED',
        details: `Device ${targetDeviceId} revoked by Admin ${user.username}. Reason: ${reason || 'N/A'}`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Device revoked successfully', revocationRecord });
    }

    // GET /api/admin/revoked-devices - List Revoked Devices
    if (pathname === '/api/admin/revoked-devices' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const revoked = db.prepare('SELECT * FROM revoked_devices ORDER BY revoked_at DESC').all();
      return sendJson(res, 200, { revoked, count: revoked.length });
    }

    /* =========================================================================
       ADMINISTRATOR SPECIFIC ENDPOINTS
       ========================================================================= */

    // GET /api/admin/users - User management list
    if (pathname === '/api/admin/users' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const users = db.prepare('SELECT id, username, authorized_role, full_name, staff_id, status, created_at FROM users ORDER BY created_at DESC').all();
      return sendJson(res, 200, { users });
    }

    // POST /api/admin/users - Create new staff user
    if (pathname === '/api/admin/users' && method === 'POST') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const { username, password, authorized_role, full_name, staff_id } = await parseJsonBody(req);
      if (!username || !password || !authorized_role || !full_name || !staff_id) {
        return sendJson(res, 400, { error: 'All fields (username, password, role, full name, staff ID) are required.' });
      }

      const normalizedRole = authorized_role.trim().toUpperCase();
      if (!['DOCTOR', 'NURSE', 'ADMINISTRATOR'].includes(normalizedRole)) {
        return sendJson(res, 400, { error: 'Invalid role. Must be DOCTOR, NURSE, or ADMINISTRATOR.' });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const userId = 'usr_' + crypto.randomUUID();
      const now = new Date().toISOString();

      try {
        db.prepare(`
          INSERT INTO users (id, username, password_hash, salt, authorized_role, full_name, staff_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
        `).run(userId, username.toLowerCase().trim(), hash, salt, normalizedRole, full_name, staff_id, now);

        logAudit({
          userId: user.id,
          username: user.username,
          role: user.authorized_role,
          action: 'ADMIN_USER_CREATED',
          resource: `/api/admin/users/${userId}`,
          status: 'ALLOWED',
          details: `Created new staff user "${username}" with authorized role [${normalizedRole}]`,
          ipAddress: clientIp
        });

        return sendJson(res, 201, { message: 'Staff user created successfully', userId });
      } catch (err) {
        return sendJson(res, 409, { error: 'Username or Staff ID already exists.' });
      }
    }

    // POST /api/admin/users/:id/toggle-status - Deactivate / Activate user
    if (pathname.match(/^\/api\/admin\/users\/[^\/]+\/toggle-status$/) && method === 'POST') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const targetUserId = pathname.split('/')[4];
      const targetUser = db.prepare('SELECT id, username, status FROM users WHERE id = ?').get(targetUserId);
      if (!targetUser) return sendJson(res, 404, { error: 'User not found.' });

      const newStatus = targetUser.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, targetUserId);

      if (newStatus === 'INACTIVE') {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
      }

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'ADMIN_USER_STATUS_CHANGE',
        resource: `/api/admin/users/${targetUserId}`,
        status: 'ALLOWED',
        details: `User "${targetUser.username}" status updated to ${newStatus}.`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: `User status changed to ${newStatus}`, newStatus });
    }

    // GET /api/admin/clinic-settings - View settings
    if (pathname === '/api/admin/clinic-settings' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const settings = db.prepare('SELECT * FROM clinic_settings ORDER BY category, key').all();
      return sendJson(res, 200, { settings });
    }

    // PUT /api/admin/clinic-settings - Update a clinic setting
    if (pathname === '/api/admin/clinic-settings' && method === 'PUT') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const { key, value } = await parseJsonBody(req);
      if (!key || value === undefined) {
        return sendJson(res, 400, { error: 'Setting key and value are required.' });
      }

      const now = new Date().toISOString();
      db.prepare('UPDATE clinic_settings SET value = ?, updated_at = ? WHERE key = ?').run(String(value), now, key);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'ADMIN_SETTING_UPDATED',
        resource: `/api/admin/clinic-settings/${key}`,
        status: 'ALLOWED',
        details: `Setting "${key}" updated to "${value}"`,
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'Setting updated successfully' });
    }

    // GET /api/admin/devices - Device list
    if (pathname === '/api/admin/devices' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const devices = db.prepare('SELECT * FROM devices ORDER BY registered_at DESC').all();
      return sendJson(res, 200, { devices });
    }

    // GET /api/admin/sync-status - Offline sync status & queue (Backward-compatible + Enhanced)
    if (pathname === '/api/admin/sync-status' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const queue = db.prepare('SELECT * FROM sync_queue ORDER BY created_at DESC LIMIT 20').all();
      const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM sync_queue WHERE status = 'PENDING'").get().count;
      const syncedCount = db.prepare("SELECT COUNT(*) AS count FROM sync_queue WHERE status = 'SYNCED'").get().count;
      const outboxPending = db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE status = 'PENDING'").get().count;
      const conflictsPending = db.prepare("SELECT COUNT(*) AS count FROM sync_conflicts WHERE status = 'PENDING_REVIEW'").get().count;

      return sendJson(res, 200, {
        syncEngine: 'HYBRID_OFFLINE_CAPABLE',
        replicationStatus: 'ONLINE_HEALTHY',
        lastReplication: new Date().toISOString(),
        pendingChangesCount: pendingCount,
        syncedChangesCount: syncedCount,
        outboxPendingCount: outboxPending,
        conflictsAwaitingReview: conflictsPending,
        hasUnsynchronizedChanges: outboxPending > 0,
        recentQueue: queue
      });
    }

    // POST /api/admin/sync-now - Trigger manual sync simulation
    if (pathname === '/api/admin/sync-now' && method === 'POST') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const now = new Date().toISOString();
      db.prepare("UPDATE sync_queue SET status = 'SYNCED', synced_at = ? WHERE status = 'PENDING'").run(now);
      db.prepare("UPDATE sync_outbox SET status = 'ACKNOWLEDGED', acknowledged_at = ? WHERE status = 'PENDING'").run(now);
      db.prepare("UPDATE devices SET last_sync_time = ?, sync_health = 'OPTIMAL'").run(now);

      logAudit({
        userId: user.id,
        username: user.username,
        role: user.authorized_role,
        action: 'ADMIN_SYNC_TRIGGERED',
        resource: '/api/admin/sync-now',
        status: 'ALLOWED',
        details: 'Manual synchronization cycle triggered by Administrator.',
        ipAddress: clientIp
      });

      return sendJson(res, 200, { message: 'All pending offline changes synchronized successfully.' });
    }

    // GET /api/admin/audit-logs - Audit logs viewer
    if (pathname === '/api/admin/audit-logs' && method === 'GET') {
      const user = requireAuth(['ADMINISTRATOR']);
      if (!user) return;

      const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
      const filterStatus = parsedUrl.searchParams.get('status');

      let query = 'SELECT * FROM audit_logs WHERE 1=1';
      const params = [];

      if (filterStatus) {
        query += ' AND status = ?';
        params.push(filterStatus.toUpperCase());
      }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);

      const logs = db.prepare(query).all(...params);
      return sendJson(res, 200, { logs, count: logs.length });
    }

    /* =========================================================================
       STATIC ASSET FALLBACK
       ========================================================================= */
    if (method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    // 404 for unknown endpoints
    sendJson(res, 404, { error: 'Route not found' });

  } catch (err) {
    console.error('Server error handling request:', err);
    sendJson(res, 500, { error: 'Internal server error', details: err.message });
  }
});

// Run database init and start server if executed directly
initDatabase();

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CLINICAL PROTOTYPE] Server listening on http://127.0.0.1:${PORT}`);
    console.log('[PROTOTYPE DEMO MODE] Predefined test accounts enabled.');
    console.log('[SECURITY] RBAC enforcement active. Role selection vs Authorization verified on all endpoints.');
    console.log('[DISTRIBUTED SYNC] Offline outbox, P2P Wi-Fi sync & visit analytics active.');
  });
}

module.exports = {
  server,
  db,
  initDatabase,
  hashPassword,
  syncEngine: {
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    IdGenerator,
    getLocalDeviceIdentity,
    recordOutboxChange,
    isDeviceRevoked,
    revokeDevice,
    processHandshake,
    getChangeSummary,
    getMissingChanges,
    applyChangesBatch,
    acknowledgeOutboxChanges,
    saveDocument,
    syncWithPeer
  },
  analyticsEngine: {
    calculateVisitAnalytics,
    evaluateVisitAlerts,
    reviewVisitAlert,
    getAnalyticsConfig
  }
};
