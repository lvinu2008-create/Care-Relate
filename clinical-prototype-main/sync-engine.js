/**
 * DISTRIBUTED OFFLINE-FIRST SYNCHRONIZATION ENGINE
 * 
 * Implements:
 * 1. Device identity & distinct entity identifier generation
 * 2. Durable local synchronization outbox with atomic transactions
 * 3. Versioned synchronization protocol (Protocol v1.0, Schema v1)
 * 4. P2P Local Wi-Fi transport & Internet synchronization service
 * 5. Field-aware & entity-aware conflict handling (No naive LWW!)
 *    - Patient contact info conflict preservation & review
 *    - Lab result dual preservation with document provenance
 *    - Prescription conflict preservation & clinical review flag
 *    - Clinical note append-only provenance preservation
 *    - Visit deduplication via stable visit IDs
 *    - Document SHA-256 integrity & hash verification
 *    - Suspected duplicate patient identity review (no auto-merge)
 * 6. Soft deletions (ARCHIVE) & approved corrections
 * 7. Device revocation & offline limitation handling
 * 8. Synchronization status & outbox retry mechanics
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateVisitAlerts } = require('./analytics-engine');

const PROTOCOL_VERSION = '1.0';
const SCHEMA_VERSION = 1;
const DOCUMENTS_DIR = path.join(__dirname, 'public', 'documents');

// Ensure documents directory exists
if (!fs.existsSync(DOCUMENTS_DIR)) {
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

/**
 * Entity ID generator helper ensuring globally unique identifiers
 */
const IdGenerator = {
  patient: () => 'pat_' + crypto.randomUUID(),
  visit: () => 'vis_' + crypto.randomUUID(),
  document: () => 'doc_' + crypto.randomUUID(),
  consultation: () => 'con_' + crypto.randomUUID(),
  medication: () => 'med_' + crypto.randomUUID(),
  observation: () => 'obs_' + crypto.randomUUID(),
  labResult: () => 'lab_' + crypto.randomUUID(),
  change: () => 'chg_' + crypto.randomUUID(),
  conflict: () => 'cnf_' + crypto.randomUUID(),
  alert: () => 'alt_' + crypto.randomUUID(),
  device: () => 'dev_' + crypto.randomUUID()
};

/**
 * Get or initialize current device installation identity
 */
function getLocalDeviceIdentity(db) {
  let deviceId = null;
  let deviceSecret = null;
  let deviceName = null;

  try {
    const idRow = db.prepare("SELECT value FROM local_device_config WHERE key = 'device_id'").get();
    if (idRow) deviceId = idRow.value;

    const secretRow = db.prepare("SELECT value FROM local_device_config WHERE key = 'device_secret'").get();
    if (secretRow) deviceSecret = secretRow.value;

    const nameRow = db.prepare("SELECT value FROM local_device_config WHERE key = 'device_name'").get();
    if (nameRow) deviceName = nameRow.value;
  } catch (e) {}

  if (!deviceId || !deviceSecret) {
    deviceId = IdGenerator.device();
    deviceSecret = crypto.randomBytes(32).toString('hex');
    deviceName = `Bedside-Tablet-${deviceId.slice(-6)}`;
    const now = new Date().toISOString();

    db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('device_id', ?)").run(deviceId);
    db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('device_secret', ?)").run(deviceSecret);
    db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('device_name', ?)").run(deviceName);
    db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('protocol_version', ?)").run(PROTOCOL_VERSION);
    db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));

    // Register into devices table as well
    try {
      db.prepare(`
        INSERT OR REPLACE INTO devices (id, device_name, device_type, assigned_station, ip_address, last_sync_time, sync_health, registered_at)
        VALUES (?, ?, 'MOBILE_TABLET', 'Station Alpha', '127.0.0.1', ?, 'OPTIMAL', ?)
      `).run(deviceId, deviceName, now, now);
    } catch (e) {}
  }

  return {
    deviceId,
    deviceSecret,
    deviceName: deviceName || `Device-${deviceId.slice(-6)}`,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION
  };
}

/**
 * Record a local business mutation into the durable sync outbox.
 * MUST be invoked inside the same database transaction as the entity mutation.
 */
function recordOutboxChange(db, {
  entityType,
  entityId,
  operationType = 'INSERT',
  payload,
  deviceId,
  revision = 1,
  dependencies = {}
}) {
  const changeId = IdGenerator.change();
  const now = new Date().toISOString();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const dependenciesStr = typeof dependencies === 'string' ? dependencies : JSON.stringify(dependencies);

  // Insert into durable sync_outbox
  db.prepare(`
    INSERT INTO sync_outbox (
      change_id, entity_type, entity_id, operation_type, device_id,
      revision, payload, timestamp, schema_version, status, dependencies,
      retry_count, last_error, created_at, acknowledged_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, NULL, ?, NULL)
  `).run(
    changeId, entityType, entityId, operationType, deviceId,
    revision, payloadStr, now, SCHEMA_VERSION, dependenciesStr, now
  );

  // Also maintain backward compatibility with legacy sync_queue table
  try {
    db.prepare(`
      INSERT INTO sync_queue (id, entity_type, entity_id, change_type, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(changeId, entityType, entityId, operationType, payloadStr, now);
  } catch (e) {}

  return {
    changeId,
    entityType,
    entityId,
    operationType,
    deviceId,
    revision,
    payload,
    timestamp: now,
    status: 'PENDING'
  };
}

/**
 * Check if a device has been administratively revoked
 */
function isDeviceRevoked(db, deviceId) {
  try {
    const row = db.prepare('SELECT device_id FROM revoked_devices WHERE device_id = ?').get(deviceId);
    return !!row;
  } catch (e) {
    return false;
  }
}

/**
 * Administratively revoke a device
 */
function revokeDevice(db, targetDeviceId, adminUser, reason = 'Administrative security revocation') {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO revoked_devices (device_id, revoked_at, revoked_by, reason)
    VALUES (?, ?, ?, ?)
  `).run(targetDeviceId, now, adminUser.username || adminUser.id, reason);

  // Update devices status
  try {
    db.prepare("UPDATE devices SET sync_health = 'OFFLINE' WHERE id = ?").run(targetDeviceId);
  } catch (e) {}

  return {
    deviceId: targetDeviceId,
    revokedAt: now,
    revokedBy: adminUser.username || adminUser.id,
    reason,
    offlineLimitationNote: 'Revocation prevents future synchronization. Note that offline copies already stored locally on the remote device remain accessible until the remote database is physically wiped.'
  };
}

/**
 * Process protocol handshake from peer or client
 */
function processHandshake(db, handshakeData) {
  const { device_id, device_name, protocol_version, schema_version, auth_token } = handshakeData;

  if (!device_id) {
    return { success: false, statusCode: 400, error: 'Missing device_id in handshake' };
  }

  // 1. Device Revocation Check
  if (isDeviceRevoked(db, device_id)) {
    return {
      success: false,
      statusCode: 403,
      error: 'DEVICE_REVOKED',
      message: 'This device identity has been administratively revoked. Synchronization is rejected.'
    };
  }

  // 2. Schema Version Negotiation
  const remoteSchema = parseInt(schema_version, 10);
  if (remoteSchema !== SCHEMA_VERSION) {
    return {
      success: false,
      statusCode: 422,
      error: 'SCHEMA_VERSION_MISMATCH',
      message: `Incompatible schema version. Expected ${SCHEMA_VERSION}, received ${remoteSchema}.`,
      supportedSchemaVersion: SCHEMA_VERSION
    };
  }

  // 3. Protocol Version Check
  if (!protocol_version || !protocol_version.startsWith('1.')) {
    return {
      success: false,
      statusCode: 422,
      error: 'PROTOCOL_VERSION_MISMATCH',
      message: `Unsupported protocol version ${protocol_version}. Required: 1.x`,
      supportedProtocolVersion: PROTOCOL_VERSION
    };
  }

  // 4. Update / Register peer
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO sync_peers (peer_device_id, peer_name, endpoint_url, last_handshake_at, is_authorized)
      VALUES (?, ?, 'p2p-wifi', ?, 1)
      ON CONFLICT(peer_device_id) DO UPDATE SET
        peer_name = excluded.peer_name,
        last_handshake_at = excluded.last_handshake_at,
        is_authorized = 1
    `).run(device_id, device_name || `Peer-${device_id.slice(-6)}`, now);
  } catch (e) {}

  const localId = getLocalDeviceIdentity(db);

  return {
    success: true,
    statusCode: 200,
    handshake: {
      status: 'ACCEPTED',
      localDeviceId: localId.deviceId,
      localDeviceName: localId.deviceName,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: SCHEMA_VERSION,
      serverTime: now
    }
  };
}

/**
 * Calculate change summary vector of outbox
 */
function getChangeSummary(db) {
  const rows = db.prepare(`
    SELECT device_id, MAX(revision) AS highest_revision, COUNT(*) AS pending_count
    FROM sync_outbox
    WHERE status = 'PENDING'
    GROUP BY device_id
  `).all();

  const vector = {};
  let totalPending = 0;
  for (const r of rows) {
    vector[r.device_id] = r.highest_revision;
    totalPending += r.pending_count;
  }

  return {
    deviceVector: vector,
    totalPendingOutbox: totalPending,
    timestamp: new Date().toISOString()
  };
}

/**
 * Retrieve missing changes since a requested revision vector
 */
function getMissingChanges(db, { sinceRevisions = {}, limit = 50 }) {
  const batchLimit = Math.min(Math.max(1, limit || 50), 200);
  
  // Pull pending or acknowledged changes that exceed the requester's known revisions
  const allChanges = db.prepare(`
    SELECT * FROM sync_outbox
    ORDER BY created_at ASC, revision ASC
  `).all();

  const missing = [];
  for (const chg of allChanges) {
    const knownRev = sinceRevisions[chg.device_id] || 0;
    if (chg.revision > knownRev) {
      missing.push({
        change_id: chg.change_id,
        entity_type: chg.entity_type,
        entity_id: chg.entity_id,
        operation_type: chg.operation_type,
        device_id: chg.device_id,
        revision: chg.revision,
        payload: JSON.parse(chg.payload),
        timestamp: chg.timestamp,
        schema_version: chg.schema_version,
        dependencies: JSON.parse(chg.dependencies || '{}')
      });
      if (missing.length >= batchLimit) break;
    }
  }

  return {
    changes: missing,
    count: missing.length,
    batchLimit,
    hasMore: missing.length === batchLimit
  };
}

/**
 * Apply a batch of incoming changes transactionally with entity-aware conflict handling.
 * 
 * Rules:
 * - Atomic transaction: either all changes in batch succeed or roll back.
 * - Idempotency: duplicate change_ids are deduplicated safely.
 * - Entity-aware conflict handling:
 *   - Patient contact info: preserve competing values, flag for review.
 *   - Lab results: never overwrite, preserve dual results with source docs.
 *   - Prescriptions: preserve conflicting orders, flag for clinical review.
 *   - Clinical notes: append-only provenance preservation.
 *   - Visits: deduplicate by stable visit ID.
 *   - Documents: verify SHA-256 hash.
 *   - Potential duplicate patient: do not auto-merge different patient IDs.
 */
function applyChangesBatch(db, changesBatch, sourceDeviceId, contextUser = { id: 'SYNC', username: 'SYNC_DAEMON', role: 'SYSTEM' }) {
  if (!Array.isArray(changesBatch) || changesBatch.length === 0) {
    return { success: true, appliedCount: 0, acknowledgedIds: [], conflictsCreated: 0 };
  }

  // Device Revocation Check
  if (isDeviceRevoked(db, sourceDeviceId)) {
    throw new Error(`Device ${sourceDeviceId} is revoked; change processing aborted.`);
  }

  const acknowledgedIds = [];
  const affectedPatientIds = new Set();
  let conflictsCreated = 0;
  let appliedCount = 0;

  db.exec('BEGIN IMMEDIATE;');

  try {
    for (const change of changesBatch) {
      const {
        change_id,
        entity_type,
        entity_id,
        operation_type,
        device_id,
        revision,
        payload,
        timestamp,
        dependencies
      } = change;

      // 1. Idempotency Check: if this change_id is already in local sync_outbox, acknowledge and skip
      const existingChange = db.prepare('SELECT change_id FROM sync_outbox WHERE change_id = ?').get(change_id);
      if (existingChange) {
        acknowledgedIds.push(change_id);
        continue;
      }

      // 2. Entity-Aware Application
      switch (entity_type) {
        case 'PATIENT': {
          const existingPat = db.prepare('SELECT * FROM patients WHERE id = ?').get(entity_id);
          if (existingPat) {
            // Check for concurrent contact info modification
            const phoneConflict = existingPat.phone && payload.phone && existingPat.phone !== payload.phone;
            const addressConflict = existingPat.address && payload.address && existingPat.address !== payload.address;

            if (phoneConflict || addressConflict) {
              // Record conflict
              const conflictId = IdGenerator.conflict();
              db.prepare(`
                INSERT INTO sync_conflicts (
                  conflict_id, entity_type, entity_id, device_id_local, device_id_remote,
                  local_revision, remote_revision, local_payload, remote_payload,
                  conflict_type, resolution_strategy, status, resolution_notes, created_at
                ) VALUES (?, 'PATIENT', ?, ?, ?, ?, ?, ?, ?, 'CONTACT_INFO_CONFLICT', 'PRESERVE_BOTH_FLAG_REVIEW', 'PENDING_REVIEW', ?, ?)
              `).run(
                conflictId, entity_id, existingPat.created_device_id || 'local', device_id,
                existingPat.revision || 1, revision,
                JSON.stringify({ phone: existingPat.phone, address: existingPat.address }),
                JSON.stringify({ phone: payload.phone, address: payload.address }),
                `Concurrent contact info update detected. Competing phone/address preserved for review.`,
                timestamp
              );
              conflictsCreated++;

              // Preserve competing phone in patient notes & flag for review
              const conflictNote = `\n[SYNC CONFLICT - Remote Device ${device_id}]: Proposed Phone: ${payload.phone || 'N/A'}, Address: ${payload.address || 'N/A'}`;
              db.prepare(`
                UPDATE patients
                SET clinical_review_flag = 1,
                    notes = COALESCE(notes, '') || ?,
                    updated_at = ?
                WHERE id = ?
              `).run(conflictNote, timestamp, entity_id);
            } else {
              // Safe update if remote revision is higher or equal
              if (revision >= (existingPat.revision || 1)) {
                db.prepare(`
                  UPDATE patients
                  SET full_name = ?, dob = ?, gender = ?, blood_type = ?,
                      allergies = ?, primary_diagnosis = ?, phone = ?, address = ?,
                      admission_status = ?, room_bed = ?, clinical_review_flag = ?,
                      revision = ?, updated_at = ?
                  WHERE id = ?
                `).run(
                  payload.full_name, payload.dob, payload.gender, payload.blood_type,
                  payload.allergies || null, payload.primary_diagnosis,
                  payload.phone || existingPat.phone, payload.address || existingPat.address,
                  payload.admission_status || existingPat.admission_status,
                  payload.room_bed || existingPat.room_bed,
                  payload.clinical_review_flag !== undefined ? payload.clinical_review_flag : existingPat.clinical_review_flag,
                  revision, timestamp, entity_id
                );
              }
            }
          } else {
            // New patient: check for potential duplicate patient by MRN or (full_name and dob)
            const duplicateCheck = db.prepare(`
              SELECT id, mrn, full_name, dob, phone FROM patients
              WHERE mrn = ? OR (full_name = ? AND dob = ?)
            `).get(payload.mrn, payload.full_name, payload.dob);

            if (duplicateCheck && duplicateCheck.id !== entity_id) {
              // Potential duplicate identity! DO NOT auto-merge!
              const conflictId = IdGenerator.conflict();
              db.prepare(`
                INSERT INTO sync_conflicts (
                  conflict_id, entity_type, entity_id, device_id_local, device_id_remote,
                  local_revision, remote_revision, local_payload, remote_payload,
                  conflict_type, resolution_strategy, status, resolution_notes, created_at
                ) VALUES (?, 'PATIENT', ?, ?, ?, 1, ?, ?, ?, 'POTENTIAL_DUPLICATE_PATIENT', 'MANUAL_CLINICIAN_REVIEW_REQUIRED', 'PENDING_REVIEW', ?, ?)
              `).run(
                conflictId, entity_id, 'local', device_id, revision,
                JSON.stringify(duplicateCheck), JSON.stringify(payload),
                `Possible duplicate patient detected matching existing ID ${duplicateCheck.id} (${duplicateCheck.full_name}, MRN: ${duplicateCheck.mrn}). Automatic merge suppressed; clinician review required.`,
                timestamp
              );
              conflictsCreated++;

              // Avoid SQLite UNIQUE constraint collision on mrn by appending duplicate suffix
              const distinctMrn = payload.mrn === duplicateCheck.mrn ? `${payload.mrn}-DUP-${entity_id.slice(-4)}` : payload.mrn;

              // Insert with review flag set to 1
              db.prepare(`
                INSERT INTO patients (
                  id, mrn, full_name, dob, gender, blood_type, allergies, primary_diagnosis,
                  assigned_doctor, assigned_nurse, admission_status, room_bed, clinical_review_flag,
                  notes, is_synthetic, updated_at, sync_status, phone, address, revision, is_archived, created_device_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'SYNCED', ?, ?, ?, 0, ?)
              `).run(
                entity_id, distinctMrn, payload.full_name, payload.dob, payload.gender,
                payload.blood_type, payload.allergies || null, payload.primary_diagnosis,
                payload.assigned_doctor || null, payload.assigned_nurse || null,
                payload.admission_status || 'OBSERVATION', payload.room_bed || null,
                `[POSSIBLE DUPLICATE]: Matches ${duplicateCheck.id}. ` + (payload.notes || ''),
                payload.is_synthetic !== undefined ? payload.is_synthetic : 1,
                timestamp, payload.phone || null, payload.address || null,
                revision, device_id
              );
            } else {
              // Clean new patient insert
              db.prepare(`
                INSERT INTO patients (
                  id, mrn, full_name, dob, gender, blood_type, allergies, primary_diagnosis,
                  assigned_doctor, assigned_nurse, admission_status, room_bed, clinical_review_flag,
                  notes, is_synthetic, updated_at, sync_status, phone, address, revision, is_archived, created_device_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED', ?, ?, ?, 0, ?)
              `).run(
                entity_id, payload.mrn, payload.full_name, payload.dob, payload.gender,
                payload.blood_type, payload.allergies || null, payload.primary_diagnosis,
                payload.assigned_doctor || null, payload.assigned_nurse || null,
                payload.admission_status || 'OBSERVATION', payload.room_bed || null,
                payload.clinical_review_flag || 0, payload.notes || null,
                payload.is_synthetic !== undefined ? payload.is_synthetic : 1,
                timestamp, payload.phone || null, payload.address || null,
                revision, device_id
              );
            }
          }
          affectedPatientIds.add(entity_id);
          break;
        }

        case 'VISIT': {
          const patientId = payload.patient_id || dependencies?.patient_id;
          const existingVisit = db.prepare('SELECT * FROM visits WHERE id = ?').get(entity_id);

          if (existingVisit) {
            // Deduplicate using stable visit IDs: if revision is higher, update; otherwise ignore
            if (revision > (existingVisit.revision || 1)) {
              db.prepare(`
                UPDATE visits
                SET status = ?, visit_type = ?, provider_name = ?, department = ?,
                    chief_complaint = ?, revision = ?, updated_at = ?
                WHERE id = ?
              `).run(
                payload.status, payload.visit_type, payload.provider_name,
                payload.department || null, payload.chief_complaint || null,
                revision, timestamp, entity_id
              );
            }
          } else {
            // Insert visit record
            db.prepare(`
              INSERT INTO visits (
                id, patient_id, visit_date, visit_type, provider_name, department,
                chief_complaint, status, is_synthetic, revision, device_id, created_at,
                updated_at, is_archived
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `).run(
              entity_id, patientId, payload.visit_date, payload.visit_type,
              payload.provider_name, payload.department || null, payload.chief_complaint || null,
              payload.status || 'CONFIRMED', payload.is_synthetic !== undefined ? payload.is_synthetic : 1,
              revision, device_id, payload.created_at || timestamp, timestamp
            );
          }
          if (patientId) affectedPatientIds.add(patientId);
          break;
        }

        case 'LAB_RESULT': {
          const patientId = payload.patient_id || dependencies?.patient_id;
          const existingLab = db.prepare('SELECT * FROM lab_results WHERE id = ?').get(entity_id);

          if (!existingLab) {
            // Check if there is an existing lab result with same test_name and collected_at with differing value
            const matchingLab = db.prepare(`
              SELECT * FROM lab_results WHERE patient_id = ? AND test_name = ? AND collected_at = ?
            `).get(patientId, payload.test_name, payload.collected_at);

            if (matchingLab && matchingLab.result_value !== payload.result_value) {
              // Dual preservation! NEVER overwrite!
              const conflictId = IdGenerator.conflict();
              db.prepare(`
                INSERT INTO sync_conflicts (
                  conflict_id, entity_type, entity_id, device_id_local, device_id_remote,
                  local_revision, remote_revision, local_payload, remote_payload,
                  conflict_type, resolution_strategy, status, resolution_notes, created_at
                ) VALUES (?, 'LAB_RESULT', ?, ?, ?, ?, ?, ?, ?, 'LAB_RESULT_PRESERVED', 'PRESERVE_BOTH', 'RESOLVED_ACCEPTED_BOTH', ?, ?)
              `).run(
                conflictId, entity_id, matchingLab.device_id || 'local', device_id,
                matchingLab.revision || 1, revision,
                JSON.stringify(matchingLab), JSON.stringify(payload),
                `Dual lab results preserved for ${payload.test_name}. Both readings recorded with source documents and dates.`,
                timestamp
              );
              conflictsCreated++;
            }

            // Insert incoming lab result
            db.prepare(`
              INSERT INTO lab_results (
                id, patient_id, test_name, test_category, result_value, unit,
                reference_range, flag, document_id, collected_at, reported_at,
                device_id, revision, is_archived, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `).run(
              entity_id, patientId, payload.test_name, payload.test_category || 'General',
              payload.result_value, payload.unit || null, payload.reference_range || null,
              payload.flag || 'NORMAL', payload.document_id || null, payload.collected_at,
              payload.reported_at || timestamp, device_id, revision, timestamp
            );
          }
          if (patientId) affectedPatientIds.add(patientId);
          break;
        }

        case 'MEDICATION_ORDER': {
          const patientId = payload.patient_id || dependencies?.patient_id;
          const existingMed = db.prepare('SELECT * FROM medication_orders WHERE id = ?').get(entity_id);

          if (existingMed) {
            // Check for concurrent prescription changes
            if (existingMed.status !== payload.status || existingMed.dosage !== payload.dosage) {
              const conflictId = IdGenerator.conflict();
              db.prepare(`
                INSERT INTO sync_conflicts (
                  conflict_id, entity_type, entity_id, device_id_local, device_id_remote,
                  local_revision, remote_revision, local_payload, remote_payload,
                  conflict_type, resolution_strategy, status, resolution_notes, created_at
                ) VALUES (?, 'MEDICATION_ORDER', ?, ?, ?, ?, ?, ?, ?, 'PRESCRIPTION_CONFLICT', 'PRESERVE_BOTH_FLAG_REVIEW', 'PENDING_REVIEW', ?, ?)
              `).run(
                conflictId, entity_id, existingMed.device_id || 'local', device_id,
                existingMed.revision || 1, revision,
                JSON.stringify(existingMed), JSON.stringify(payload),
                `Prescription status/dosage divergence detected. Conflicting prescription preserved and flagged for authorized clinical review.`,
                timestamp
              );
              conflictsCreated++;

              // Flag patient chart for clinical attention
              db.prepare('UPDATE patients SET clinical_review_flag = 1 WHERE id = ?').run(patientId);
            } else if (revision > (existingMed.revision || 1)) {
              db.prepare(`
                UPDATE medication_orders
                SET status = ?, dosage = ?, frequency = ?, updated_at = ?, revision = ?
                WHERE id = ?
              `).run(payload.status, payload.dosage, payload.frequency, timestamp, revision, entity_id);
            }
          } else {
            // New medication order
            db.prepare(`
              INSERT INTO medication_orders (
                id, patient_id, doctor_id, doctor_name, medication_name,
                dosage, route, frequency, status, ordered_at, revision, device_id, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              entity_id,
              patientId || null,
              payload.doctor_id || 'usr_doc_01',
              payload.doctor_name || 'Dr. Sarah Bennett, MD',
              payload.medication_name,
              payload.dosage,
              payload.route || 'Oral',
              payload.frequency,
              payload.status || 'ACTIVE',
              payload.ordered_at || timestamp,
              revision || 1,
              device_id || 'local',
              timestamp
            );

            // Generate nursing task if not existing
            const taskId = 'task_' + crypto.randomUUID();
            db.prepare(`
              INSERT INTO nursing_tasks (id, patient_id, medication_order_id, task_type, description, scheduled_time, status)
              VALUES (?, ?, ?, 'MEDICATION_ADMIN', ?, 'Next Scheduled Dose', 'PENDING')
            `).run(taskId, patientId || null, entity_id, `Administer ${payload.medication_name} ${payload.dosage} (${payload.frequency})`);
          }
          if (patientId) affectedPatientIds.add(patientId);
          break;
        }

        case 'CONSULTATION': {
          const patientId = payload.patient_id || dependencies?.patient_id;
          const existingConsult = db.prepare('SELECT id FROM consultations WHERE id = ?').get(entity_id);

          if (!existingConsult) {
            // Ensure remote provider exists in users table to satisfy foreign key
            const docId = payload.doctor_id || 'usr_doc_01';
            const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(docId);
            if (!userExists) {
              db.prepare(`
                INSERT OR IGNORE INTO users (id, username, password_hash, salt, authorized_role, full_name, staff_id, status, created_at)
                VALUES (?, ?, 'REMOTE_HASH', 'SALT', 'DOCTOR', ?, ?, 'ACTIVE', ?)
              `).run(docId, docId.toLowerCase(), payload.doctor_name || 'Visiting Clinician', 'STF-' + docId.slice(-6), timestamp);
            }

            // Consultations are append-only clinical notes; preserve provenance intact
            db.prepare(`
              INSERT INTO consultations (
                id, patient_id, doctor_id, doctor_name, chief_complaint, assessment,
                treatment_plan, clinical_review_flag, timestamp, revision, device_id, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              entity_id,
              patientId || null,
              docId,
              payload.doctor_name || 'Dr. Sarah Bennett, MD',
              payload.chief_complaint || 'Clinical Note',
              payload.assessment,
              payload.treatment_plan,
              payload.clinical_review_flag || 0,
              payload.timestamp || timestamp,
              revision || 1,
              device_id || 'local',
              timestamp
            );
          }
          if (patientId) affectedPatientIds.add(patientId);
          break;
        }

        case 'DOCUMENT': {
          const patientId = payload.patient_id || dependencies?.patient_id;
          const docId = payload.id || entity_id;
          const existingDoc = db.prepare('SELECT id, sha256_hash FROM documents WHERE id = ?').get(docId);

          // If content payload is included, verify hash
          if (payload.content_base64) {
            const buffer = Buffer.from(payload.content_base64, 'base64');
            const computedHash = crypto.createHash('sha256').update(buffer).digest('hex');
            if (computedHash !== payload.sha256_hash) {
              throw new Error(`Document ${docId} SHA-256 hash verification failed! Expected ${payload.sha256_hash}, computed ${computedHash}`);
            }
            // Save payload to documents directory
            const filePath = path.join(DOCUMENTS_DIR, `${docId}.dat`);
            fs.writeFileSync(filePath, buffer);
          }

          if (!existingDoc) {
            db.prepare(`
              INSERT INTO documents (
                id, patient_id, visit_id, title, document_type, mime_type, file_size,
                sha256_hash, storage_path, device_id, uploaded_at, revision, is_archived, sync_status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'SYNCED')
            `).run(
              docId, patientId || null, payload.visit_id || null, payload.title,
              payload.document_type || 'CLINICAL_NOTE', payload.mime_type || 'application/octet-stream',
              payload.file_size || 0, payload.sha256_hash,
              `documents/${docId}.dat`, device_id, payload.uploaded_at || timestamp,
              revision || 1
            );
          }
          if (patientId) affectedPatientIds.add(patientId);
          break;
        }

        case 'ARCHIVE': {
          // Soft-delete: update target table
          const targetTable = payload.target_table;
          if (['patients', 'visits', 'documents', 'medication_orders'].includes(targetTable)) {
            db.prepare(`
              UPDATE ${targetTable}
              SET is_archived = 1, updated_at = ?
              WHERE id = ?
            `).run(timestamp, entity_id);
          }
          break;
        }

        default:
          break;
      }

      // Record in local sync_outbox as already synchronized/acknowledged so we don't re-echo
      db.prepare(`
        INSERT OR REPLACE INTO sync_outbox (
          change_id, entity_type, entity_id, operation_type, device_id, revision,
          payload, timestamp, schema_version, status, dependencies, retry_count,
          last_error, created_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACKNOWLEDGED', ?, 0, NULL, ?, ?)
      `).run(
        change_id, entity_type, entity_id, operation_type, device_id, revision,
        JSON.stringify(payload), timestamp, SCHEMA_VERSION,
        JSON.stringify(dependencies || {}), timestamp, timestamp
      );

      acknowledgedIds.push(change_id);
      appliedCount++;
    }

    // Update peer sync state
    const nowIso = new Date().toISOString();
    try {
      db.prepare(`
        UPDATE sync_peers
        SET last_successful_sync_at = ?,
            last_sync_status = 'OPTIMAL'
        WHERE peer_device_id = ?
      `).run(nowIso, sourceDeviceId);
    } catch (e) {}

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  // Recalculate visit analytics & alerts for all affected patients outside the transaction
  for (const patientId of affectedPatientIds) {
    try {
      evaluateVisitAlerts(db, patientId, new Date(), sourceDeviceId);
    } catch (e) {
      console.error(`Failed to re-evaluate visit alerts for patient ${patientId}:`, e);
    }
  }

  return {
    success: true,
    appliedCount,
    acknowledgedIds,
    conflictsCreated,
    affectedPatientCount: affectedPatientIds.size
  };
}

/**
 * Acknowledge outbox changes confirmed by receiving sync partner
 */
function acknowledgeOutboxChanges(db, acknowledgedIds) {
  if (!Array.isArray(acknowledgedIds) || acknowledgedIds.length === 0) return 0;
  const now = new Date().toISOString();

  let count = 0;
  for (const id of acknowledgedIds) {
    const res = db.prepare(`
      UPDATE sync_outbox
      SET status = 'ACKNOWLEDGED', acknowledged_at = ?
      WHERE change_id = ?
    `).run(now, id);
    if (res.changes > 0) count++;

    // Backward compatibility for sync_queue
    try {
      db.prepare("UPDATE sync_queue SET status = 'SYNCED', synced_at = ? WHERE id = ?").run(now, id);
    } catch (e) {}
  }

  return count;
}

/**
 * Store and hash a medical document
 */
function saveDocument(db, {
  patientId,
  visitId = null,
  title,
  documentType = 'CLINICAL_NOTE',
  mimeType = 'text/plain',
  contentBuffer,
  deviceId
}) {
  const docId = IdGenerator.document();
  const sha256Hash = crypto.createHash('sha256').update(contentBuffer).digest('hex');
  const fileSize = contentBuffer.length;
  const now = new Date().toISOString();
  const storagePath = `documents/${docId}.dat`;
  const fullPath = path.join(DOCUMENTS_DIR, `${docId}.dat`);

  fs.writeFileSync(fullPath, contentBuffer);

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO documents (
        id, patient_id, visit_id, title, document_type, mime_type, file_size,
        sha256_hash, storage_path, device_id, uploaded_at, revision, is_archived, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'PENDING')
    `).run(
      docId, patientId, visitId, title, documentType, mimeType, fileSize,
      sha256Hash, storagePath, deviceId, now
    );

    recordOutboxChange(db, {
      entityType: 'DOCUMENT',
      entityId: docId,
      operationType: 'INSERT',
      payload: {
        id: docId,
        patient_id: patientId,
        visit_id: visitId,
        title,
        document_type: documentType,
        mime_type: mimeType,
        file_size: fileSize,
        sha256_hash: sha256Hash,
        content_base64: contentBuffer.toString('base64'),
        uploaded_at: now
      },
      deviceId,
      revision: 1,
      dependencies: { patient_id: patientId }
    });

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    docId,
    sha256Hash,
    fileSize,
    title,
    uploadedAt: now
  };
}

/**
 * Direct device-to-device Wi-Fi synchronization cycle simulator
 * Performs full bidirectional exchange between local node and a target peer
 */
async function syncWithPeer(localDb, peerEngine) {
  const localId = getLocalDeviceIdentity(localDb);

  // 1. Handshake with peer
  const handshakeRes = peerEngine.handleHandshake({
    device_id: localId.deviceId,
    device_name: localId.deviceName,
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION
  });

  if (!handshakeRes.success) {
    throw new Error(`Peer handshake rejected: ${handshakeRes.error} - ${handshakeRes.message}`);
  }

  // 2. Summary & Missing Changes Exchange (Local -> Remote)
  const remoteSummary = peerEngine.getSummary();
  const outgoing = getMissingChanges(localDb, { sinceRevisions: remoteSummary.deviceVector });

  let peerAck = { acknowledgedIds: [] };
  if (outgoing.count > 0) {
    peerAck = peerEngine.receiveChanges(outgoing.changes, localId.deviceId);
    acknowledgeOutboxChanges(localDb, peerAck.acknowledgedIds);
  }

  // 3. Reverse Pull (Remote -> Local)
  const localSummary = getChangeSummary(localDb);
  const incoming = peerEngine.pullChanges({ sinceRevisions: localSummary.deviceVector });

  let localAck = { acknowledgedIds: [] };
  if (incoming.count > 0) {
    localAck = applyChangesBatch(localDb, incoming.changes, peerEngine.getDeviceId());
    peerEngine.acknowledgeChanges(localAck.acknowledgedIds);
  }

  return {
    success: true,
    pushedCount: outgoing.count,
    pulledCount: incoming.count,
    peerAcknowledged: peerAck.acknowledgedIds.length,
    localAcknowledged: localAck.acknowledgedIds.length
  };
}

module.exports = {
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
};
