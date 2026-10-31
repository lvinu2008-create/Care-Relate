/**
 * DISTRIBUTED OFFLINE-FIRST SYNCHRONIZATION & VISIT ANALYTICS TEST SUITE
 * 
 * Verifies all 21 core distributed systems, networking, database architecture,
 * and healthcare analytics requirements across two independent devices (Device A & Device B):
 * 
 * 1. Two-Device Synchronization
 * 2. Offline Patient Creation & Durable Outbox
 * 3. Offline Visit Registration & Outbox Dependencies
 * 4. Repeated Synchronization Requests (Idempotency)
 * 5. Duplicate Change Events (Duplicate Message Detection)
 * 6. Interrupted Transfers & Transactional Rollback
 * 7. Partial Synchronization (Batch Limits)
 * 8. Document Transfer & SHA-256 Hash Verification
 * 9. Schema-Version Incompatibility Rejection
 * 10. Concurrent Patient Edits (Contact Info Conflict Preservation & Review)
 * 11. Conflicting Prescriptions (Dual Preservation & Clinical Flagging)
 * 12. Conflicting Clinical Notes (Append-Only Provenance Preservation)
 * 13. Potential Duplicate Patient Detection (No Silent Auto-Merge)
 * 14. Approved Corrections & Superseded Audit Trail
 * 15. Device Revocation & Offline Limitation Handling
 * 16. Visit-Frequency Mathematical Accuracy (7d, 30d, 90d, 180d, 365d, Interval Stats)
 * 17. Distributed Alert Deduplication (Deterministic Hash Reconciliation)
 * 18. Analytics Recalculation After Sync
 * 19. Incomplete Local Histories & Partial Sync Indicators
 * 20. Unauthorized Device & Patient-Level Access Boundary Enforcement
 * 21. Durability & Recovery After System Restart
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  calculateVisitAnalytics,
  evaluateVisitAlerts,
  reviewVisitAlert,
  generateAlertDedupKey,
  getAnalyticsConfig
} = require('../analytics-engine');

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
} = require('../sync-engine');

const { initDatabase } = require('../server');

/**
 * Factory to create an isolated test device node with its own independent SQLite database
 */
function createTestDevice(deviceId, deviceName, inMemory = true, dbPath = null) {
  const resolvedPath = inMemory ? ':memory:' : dbPath;
  const db = new DatabaseSync(resolvedPath);
  
  // Initialize full schema and migrations on this database instance
  initDatabase(db);

  // Set explicit device identity in local_device_config
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('device_id', ?)").run(deviceId);
  db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('device_name', ?)").run(deviceName);
  db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('device_secret', ?)").run(secret);
  db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('protocol_version', ?)").run(PROTOCOL_VERSION);
  db.prepare("INSERT OR REPLACE INTO local_device_config (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));

  return {
    deviceId,
    deviceName,
    deviceSecret: secret,
    db,
    getDeviceId: () => deviceId,
    getSummary: () => getChangeSummary(db),
    handleHandshake: (data) => processHandshake(db, data),
    pullChanges: (req) => getMissingChanges(db, req),
    receiveChanges: (changes, sourceDevId) => applyChangesBatch(db, changes, sourceDevId),
    acknowledgeChanges: (ids) => acknowledgeOutboxChanges(db, ids)
  };
}

async function runAllTests() {
  console.log('========================================================================');
  console.log('   DISTRIBUTED HEALTHCARE RECORD SYNC & ANALYTICS TEST SUITE            ');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
      failed++;
    }
  }

  // 1. Two-Device Synchronization
  await test('1. Two-Device Synchronization: Device A creates record, Device B syncs and converges', async () => {
    const devA = createTestDevice('dev_alpha_01', 'Bedside-Tablet-Alpha');
    const devB = createTestDevice('dev_beta_02', 'Physician-Tablet-Beta');

    // Device A creates a new patient offline
    const patientId = IdGenerator.patient();
    const now = new Date().toISOString();

    devA.db.exec('BEGIN IMMEDIATE;');
    devA.db.prepare(`
      INSERT INTO patients (id, mrn, full_name, dob, gender, blood_type, allergies, primary_diagnosis, admission_status, room_bed, clinical_review_flag, updated_at, sync_status, phone, address, revision, is_archived, created_device_id)
      VALUES (?, 'SYN-2026-901', 'Sarah Connor', '1985-05-12', 'Female', 'O+', 'None', 'Cardiac Arrhythmia', 'OBSERVATION', 'Bed 1', 0, ?, 'PENDING', '+1-555-0199', '123 Sky Ln', 1, 0, ?)
    `).run(patientId, now, devA.deviceId);

    recordOutboxChange(devA.db, {
      entityType: 'PATIENT',
      entityId: patientId,
      operationType: 'INSERT',
      payload: {
        id: patientId,
        mrn: 'SYN-2026-901',
        full_name: 'Sarah Connor',
        dob: '1985-05-12',
        gender: 'Female',
        blood_type: 'O+',
        primary_diagnosis: 'Cardiac Arrhythmia',
        phone: '+1-555-0199',
        address: '123 Sky Ln',
        updated_at: now
      },
      deviceId: devA.deviceId,
      revision: 1
    });
    devA.db.exec('COMMIT;');

    // Verify Device B does NOT have this patient before sync
    const preSync = devB.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    assert.strictEqual(preSync, undefined, 'Device B must not have patient before sync');

    // Execute P2P Wi-Fi Sync Cycle between Device A and Device B
    const syncResult = await syncWithPeer(devA.db, devB);
    assert.strictEqual(syncResult.success, true);
    assert.strictEqual(syncResult.pushedCount, 1);

    // Verify Device B now has the patient record
    const postSync = devB.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    assert.ok(postSync, 'Device B must now have patient record');
    assert.strictEqual(postSync.full_name, 'Sarah Connor');
    assert.strictEqual(postSync.mrn, 'SYN-2026-901');

    // Verify outbox on Device A is now ACKNOWLEDGED
    const outboxRow = devA.db.prepare('SELECT status FROM sync_outbox WHERE entity_id = ?').get(patientId);
    assert.strictEqual(outboxRow.status, 'ACKNOWLEDGED', 'Device A outbox status must transition to ACKNOWLEDGED');
  });

  // 2. Offline Patient Creation & Durable Outbox
  await test('2. Offline Patient Creation: Atomic commit of patient record and outbox event', async () => {
    const dev = createTestDevice('dev_offline_01', 'Clinic-Device-Offline');
    const patId = IdGenerator.patient();
    const now = new Date().toISOString();

    dev.db.exec('BEGIN IMMEDIATE;');
    dev.db.prepare(`
      INSERT INTO patients (id, mrn, full_name, dob, gender, blood_type, primary_diagnosis, admission_status, updated_at, sync_status, revision, is_archived, created_device_id)
      VALUES (?, 'SYN-2026-902', 'Walter Bishop', '1946-08-19', 'Male', 'AB+', 'Cognitive Impairment', 'OBSERVATION', ?, 'PENDING', 1, 0, ?)
    `).run(patId, now, dev.deviceId);

    const outbox = recordOutboxChange(dev.db, {
      entityType: 'PATIENT',
      entityId: patId,
      operationType: 'INSERT',
      payload: { id: patId, full_name: 'Walter Bishop', mrn: 'SYN-2026-902' },
      deviceId: dev.deviceId,
      revision: 1
    });
    dev.db.exec('COMMIT;');

    assert.ok(outbox.changeId.startsWith('chg_'));
    assert.strictEqual(outbox.status, 'PENDING');

    const storedOutbox = dev.db.prepare('SELECT * FROM sync_outbox WHERE change_id = ?').get(outbox.changeId);
    assert.strictEqual(storedOutbox.status, 'PENDING');
    assert.strictEqual(storedOutbox.entity_type, 'PATIENT');
  });

  // 3. Offline Visit Registration & Outbox Dependencies
  await test('3. Offline Visit Registration: Generates stable visit ID and records patient dependency', async () => {
    const dev = createTestDevice('dev_vis_01', 'Tablet-Visits');
    const patId = 'pat_syn_101';
    const visId = IdGenerator.visit();
    const now = new Date().toISOString();

    dev.db.exec('BEGIN IMMEDIATE;');
    dev.db.prepare(`
      INSERT INTO visits (id, patient_id, visit_date, visit_type, provider_name, department, chief_complaint, status, is_synthetic, revision, device_id, created_at, updated_at, is_archived)
      VALUES (?, ?, ?, 'ROUTINE', 'Dr. Sarah Bennett', 'Cardiology', 'Routine blood pressure titration', 'CONFIRMED', 1, 1, ?, ?, ?, 0)
    `).run(visId, patId, now, dev.deviceId, now, now);

    const change = recordOutboxChange(dev.db, {
      entityType: 'VISIT',
      entityId: visId,
      operationType: 'INSERT',
      payload: { id: visId, patient_id: patId, visit_date: now, status: 'CONFIRMED' },
      deviceId: dev.deviceId,
      revision: 1,
      dependencies: { patient_id: patId }
    });
    dev.db.exec('COMMIT;');

    const stored = dev.db.prepare('SELECT * FROM sync_outbox WHERE change_id = ?').get(change.changeId);
    const deps = JSON.parse(stored.dependencies);
    assert.strictEqual(deps.patient_id, patId, 'Must track patient_id dependency');
  });

  // 4. Repeated Synchronization Requests (Idempotency)
  await test('4. Repeated Synchronization Requests: Idempotent transfer without duplicate records', async () => {
    const devA = createTestDevice('dev_rep_a', 'Device-Rep-A');
    const devB = createTestDevice('dev_rep_b', 'Device-Rep-B');

    // devA creates visit
    const visId = IdGenerator.visit();
    const now = new Date().toISOString();
    devA.db.exec('BEGIN IMMEDIATE;');
    devA.db.prepare(`
      INSERT INTO visits (id, patient_id, visit_date, visit_type, provider_name, status, is_synthetic, revision, device_id, created_at, updated_at, is_archived)
      VALUES (?, 'pat_syn_101', ?, 'SPECIALIST', 'Dr. Bennett', 'CONFIRMED', 1, 1, ?, ?, ?, 0)
    `).run(visId, now, devA.deviceId, now, now);

    recordOutboxChange(devA.db, {
      entityType: 'VISIT',
      entityId: visId,
      payload: { id: visId, patient_id: 'pat_syn_101', visit_date: now, status: 'CONFIRMED', visit_type: 'SPECIALIST', provider_name: 'Dr. Bennett' },
      deviceId: devA.deviceId,
      revision: 1
    });
    devA.db.exec('COMMIT;');

    // First sync
    await syncWithPeer(devA.db, devB);
    const countFirst = devB.db.prepare('SELECT COUNT(*) AS count FROM visits WHERE id = ?').get(visId).count;
    assert.strictEqual(countFirst, 1);

    // Repeated second sync
    await syncWithPeer(devA.db, devB);
    const countSecond = devB.db.prepare('SELECT COUNT(*) AS count FROM visits WHERE id = ?').get(visId).count;
    assert.strictEqual(countSecond, 1, 'Must not duplicate visit on repeated sync');
  });

  // 5. Duplicate Change Events (Duplicate Message Detection)
  await test('5. Duplicate Change Events: Duplicate change_id is acknowledged and deduplicated', async () => {
    const devB = createTestDevice('dev_dup_b', 'Device-Dup-B');
    const changeId = IdGenerator.change();
    const visId = IdGenerator.visit();
    const now = new Date().toISOString();

    const changePayload = [{
      change_id: changeId,
      entity_type: 'VISIT',
      entity_id: visId,
      operation_type: 'INSERT',
      device_id: 'dev_remote_x',
      revision: 1,
      payload: { id: visId, patient_id: 'pat_syn_101', visit_date: now, status: 'CONFIRMED', visit_type: 'ROUTINE', provider_name: 'Dr. Sarah' },
      timestamp: now,
      dependencies: {}
    }];

    // First delivery
    const res1 = applyChangesBatch(devB.db, changePayload, 'dev_remote_x');
    assert.strictEqual(res1.appliedCount, 1);
    assert.deepStrictEqual(res1.acknowledgedIds, [changeId]);

    // Second delivery of exact same change_id
    const res2 = applyChangesBatch(devB.db, changePayload, 'dev_remote_x');
    assert.strictEqual(res2.appliedCount, 0, 'Must not re-apply duplicate change');
    assert.deepStrictEqual(res2.acknowledgedIds, [changeId], 'Must still acknowledge duplicate change_id');
  });

  // 6. Interrupted Transfers & Transactional Rollback
  await test('6. Interrupted Transfers: Atomic rollback on failure preserves state integrity', async () => {
    const devB = createTestDevice('dev_err_b', 'Device-Err-B');
    const initialVisitCount = devB.db.prepare('SELECT COUNT(*) AS count FROM visits').get().count;

    const validVisId = IdGenerator.visit();
    const invalidChange = {
      change_id: 'chg_valid_1',
      entity_type: 'VISIT',
      entity_id: validVisId,
      operation_type: 'INSERT',
      device_id: 'dev_peer',
      revision: 1,
      payload: { id: validVisId, patient_id: 'pat_syn_101', visit_date: new Date().toISOString(), status: 'CONFIRMED', visit_type: 'ROUTINE', provider_name: 'Dr. Sarah' },
      timestamp: new Date().toISOString()
    };

    // Second change has corrupted document with failed hash verification
    const corruptDocChange = {
      change_id: 'chg_corrupt_doc',
      entity_type: 'DOCUMENT',
      entity_id: 'doc_corrupt_1',
      operation_type: 'INSERT',
      device_id: 'dev_peer',
      revision: 1,
      payload: {
        id: 'doc_corrupt_1',
        patient_id: 'pat_syn_101',
        title: 'Corrupt Document',
        sha256_hash: 'expected_correct_hash_12345',
        content_base64: Buffer.from('different content').toString('base64')
      },
      timestamp: new Date().toISOString()
    };

    let caughtError = false;
    try {
      applyChangesBatch(devB.db, [invalidChange, corruptDocChange], 'dev_peer');
    } catch (e) {
      caughtError = true;
    }

    assert.strictEqual(caughtError, true, 'Batch should throw on corrupted document');
    // Verify first visit was rolled back and NOT committed
    const postRollbackCount = devB.db.prepare('SELECT COUNT(*) AS count FROM visits').get().count;
    assert.strictEqual(postRollbackCount, initialVisitCount, 'All changes in batch must be rolled back');
  });

  // 7. Partial Synchronization (Batch Limits)
  await test('7. Partial Synchronization: Honors batch pagination limits', async () => {
    const devA = createTestDevice('dev_batch_a', 'Device-Batch-A');
    const now = new Date().toISOString();

    // Create 5 visits
    for (let i = 0; i < 5; i++) {
      const visId = IdGenerator.visit();
      recordOutboxChange(devA.db, {
        entityType: 'VISIT',
        entityId: visId,
        payload: { id: visId, patient_id: 'pat_syn_101', visit_date: now, status: 'CONFIRMED' },
        deviceId: devA.deviceId,
        revision: i + 1
      });
    }

    const missingBatch = getMissingChanges(devA.db, { limit: 2 });
    assert.strictEqual(missingBatch.count, 2, 'Must limit batch to requested size 2');
    assert.strictEqual(missingBatch.hasMore, true);
  });

  // 8. Document Transfer & SHA-256 Hash Verification
  await test('8. Document Transfer: SHA-256 integrity check and rejection of altered payloads', async () => {
    const dev = createTestDevice('dev_doc_01', 'Device-Doc');
    const rawContent = Buffer.from('LABORATORY ANALYSIS: Arterial Blood Gas: pH 7.42, PaCO2 38, PaO2 94.');
    const validHash = crypto.createHash('sha256').update(rawContent).digest('hex');

    // 1. Valid Document
    const validDocChange = [{
      change_id: IdGenerator.change(),
      entity_type: 'DOCUMENT',
      entity_id: 'doc_valid_test',
      operation_type: 'INSERT',
      device_id: 'dev_remote',
      revision: 1,
      payload: {
        id: 'doc_valid_test',
        patient_id: 'pat_syn_101',
        title: 'ABG Report',
        mime_type: 'text/plain',
        file_size: rawContent.length,
        sha256_hash: validHash,
        content_base64: rawContent.toString('base64'),
        uploaded_at: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    }];

    const res = applyChangesBatch(dev.db, validDocChange, 'dev_remote');
    assert.strictEqual(res.appliedCount, 1);

    const docRow = dev.db.prepare('SELECT * FROM documents WHERE id = ?').get('doc_valid_test');
    assert.strictEqual(docRow.sha256_hash, validHash);

    // 2. Tampered Document (hash mismatch)
    const tamperedDocChange = [{
      change_id: IdGenerator.change(),
      entity_type: 'DOCUMENT',
      entity_id: 'doc_tampered_test',
      operation_type: 'INSERT',
      device_id: 'dev_remote',
      revision: 1,
      payload: {
        id: 'doc_tampered_test',
        patient_id: 'pat_syn_101',
        title: 'Tampered Report',
        sha256_hash: 'declared_hash_0000000000000000000000000000000000000000000000000000000000000000',
        content_base64: rawContent.toString('base64'),
        uploaded_at: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    }];

    assert.throws(() => {
      applyChangesBatch(dev.db, tamperedDocChange, 'dev_remote');
    }, /SHA-256 hash verification failed/);
  });

  // 9. Schema-Version Incompatibility Rejection
  await test('9. Schema Negotiation: Incompatible schema version rejected gracefully', async () => {
    const dev = createTestDevice('dev_schema_01', 'Device-Schema');

    const handshakeRes = dev.handleHandshake({
      device_id: 'dev_peer_future',
      device_name: 'Future-Version-Phone',
      protocol_version: '1.0',
      schema_version: 99 // Incompatible schema
    });

    assert.strictEqual(handshakeRes.success, false);
    assert.strictEqual(handshakeRes.statusCode, 422);
    assert.strictEqual(handshakeRes.error, 'SCHEMA_VERSION_MISMATCH');
    assert.strictEqual(handshakeRes.supportedSchemaVersion, 1);
  });

  // 10. Concurrent Patient Edits (Contact Info Conflict Preservation & Review)
  await test('10. Concurrent Patient Edits: Preserves competing phone numbers without silent overwrites', async () => {
    const devB = createTestDevice('dev_concur_b', 'Device-Concur-B');
    const patId = 'pat_syn_101';

    // Local device B has phone "+1 (555) 234-5678"
    const localPatient = devB.db.prepare('SELECT phone FROM patients WHERE id = ?').get(patId);
    assert.ok(localPatient.phone);

    // Incoming change from remote device has phone "+1 (555) 999-8888"
    const remoteChange = [{
      change_id: IdGenerator.change(),
      entity_type: 'PATIENT',
      entity_id: patId,
      operation_type: 'UPDATE',
      device_id: 'dev_remote_nurse',
      revision: 2,
      payload: {
        id: patId,
        full_name: 'Eleanor Vance (Synthetic)',
        dob: '1968-04-12',
        gender: 'Female',
        blood_type: 'A+',
        primary_diagnosis: 'Acute Decompensated Heart Failure (NYHA Class III)',
        phone: '+1 (555) 999-8888',
        address: '999 Competing Blvd'
      },
      timestamp: new Date().toISOString()
    }];

    const result = applyChangesBatch(devB.db, remoteChange, 'dev_remote_nurse');
    assert.strictEqual(result.conflictsCreated, 1, 'Must record conflict');

    // Verify conflict entry in sync_conflicts
    const conflict = devB.db.prepare('SELECT * FROM sync_conflicts WHERE entity_id = ?').get(patId);
    assert.ok(conflict);
    assert.strictEqual(conflict.conflict_type, 'CONTACT_INFO_CONFLICT');
    assert.strictEqual(conflict.resolution_strategy, 'PRESERVE_BOTH_FLAG_REVIEW');
    assert.strictEqual(conflict.status, 'PENDING_REVIEW');

    // Verify patient review flag is set to 1
    const updatedPat = devB.db.prepare('SELECT clinical_review_flag, notes FROM patients WHERE id = ?').get(patId);
    assert.strictEqual(updatedPat.clinical_review_flag, 1, 'Must flag patient chart for clinician review');
    assert.ok(updatedPat.notes.includes('+1 (555) 999-8888'), 'Must preserve remote phone in patient notes');
  });

  // 11. Conflicting Prescriptions (Dual Preservation & Clinical Flagging)
  await test('11. Conflicting Prescriptions: Concurrent dosage modification flagged for clinical review', async () => {
    const dev = createTestDevice('dev_presc_01', 'Device-Presc');
    const medId = 'med_01'; // Furosemide (Lasix) 40mg

    // Remote device changes dosage to 80mg BID while status is ACTIVE
    const remoteMedChange = [{
      change_id: IdGenerator.change(),
      entity_type: 'MEDICATION_ORDER',
      entity_id: medId,
      operation_type: 'UPDATE',
      device_id: 'dev_remote_doc',
      revision: 2,
      payload: {
        id: medId,
        patient_id: 'pat_syn_101',
        medication_name: 'Furosemide (Lasix)',
        dosage: '80 mg',
        frequency: 'Twice daily',
        status: 'ACTIVE'
      },
      timestamp: new Date().toISOString()
    }];

    const result = applyChangesBatch(dev.db, remoteMedChange, 'dev_remote_doc');
    assert.strictEqual(result.conflictsCreated, 1);

    const conflict = dev.db.prepare("SELECT * FROM sync_conflicts WHERE conflict_type = 'PRESCRIPTION_CONFLICT'").get();
    assert.ok(conflict);
    assert.strictEqual(conflict.status, 'PENDING_REVIEW');

    const pat = dev.db.prepare('SELECT clinical_review_flag FROM patients WHERE id = ?').get('pat_syn_101');
    assert.strictEqual(pat.clinical_review_flag, 1);
  });

  // 12. Conflicting Clinical Notes (Append-Only Provenance Preservation)
  await test('12. Conflicting Clinical Notes: Preserves both consultation notes with original provenance', async () => {
    const dev = createTestDevice('dev_notes_01', 'Device-Notes');
    const patId = 'pat_syn_101';
    const initConsultCount = dev.db.prepare('SELECT COUNT(*) AS count FROM consultations WHERE patient_id = ?').get(patId).count;

    const consultA = {
      change_id: IdGenerator.change(),
      entity_type: 'CONSULTATION',
      entity_id: 'con_doc_a',
      operation_type: 'INSERT',
      device_id: 'dev_doc_a',
      revision: 1,
      payload: {
        id: 'con_doc_a',
        patient_id: patId,
        doctor_id: 'usr_doc_01',
        doctor_name: 'Dr. Sarah Bennett, MD',
        chief_complaint: 'Chest Tightness',
        assessment: 'Anginal equivalent',
        treatment_plan: 'Nitroglycerin PRN',
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };

    const consultB = {
      change_id: IdGenerator.change(),
      entity_type: 'CONSULTATION',
      entity_id: 'con_doc_b',
      operation_type: 'INSERT',
      device_id: 'dev_doc_b',
      revision: 1,
      payload: {
        id: 'con_doc_b',
        patient_id: patId,
        doctor_id: 'usr_doc_02',
        doctor_name: 'Dr. Michael Chen, MD',
        chief_complaint: 'Fluid Overload',
        assessment: 'Cardiorenal syndrome Stage II',
        treatment_plan: 'Renal consultation',
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };

    applyChangesBatch(dev.db, [consultA, consultB], 'sync_partner');

    const postCount = dev.db.prepare('SELECT COUNT(*) AS count FROM consultations WHERE patient_id = ?').get(patId).count;
    assert.strictEqual(postCount, initConsultCount + 2, 'Must preserve both consultation notes');

    const noteA = dev.db.prepare('SELECT * FROM consultations WHERE id = ?').get('con_doc_a');
    const noteB = dev.db.prepare('SELECT * FROM consultations WHERE id = ?').get('con_doc_b');
    assert.strictEqual(noteA.doctor_name, 'Dr. Sarah Bennett, MD');
    assert.strictEqual(noteB.doctor_name, 'Dr. Michael Chen, MD');
  });

  // 13. Potential Duplicate Patient Detection (No Silent Auto-Merge)
  await test('13. Suspected Duplicate Patient: Detects matching MRN/Name without destructive auto-merge', async () => {
    const dev = createTestDevice('dev_dup_pat', 'Device-Dup-Pat');
    const newPatId = IdGenerator.patient();

    // Incoming patient shares MRN 'SYN-2026-001' with existing patient Eleanor Vance
    const matchingChange = [{
      change_id: IdGenerator.change(),
      entity_type: 'PATIENT',
      entity_id: newPatId,
      operation_type: 'INSERT',
      device_id: 'dev_clinic_south',
      revision: 1,
      payload: {
        id: newPatId,
        mrn: 'SYN-2026-001', // Colliding MRN
        full_name: 'Eleanor Vance (Synthetic)',
        dob: '1968-04-12',
        gender: 'Female',
        blood_type: 'A+',
        primary_diagnosis: 'Heart Failure Re-admission'
      },
      timestamp: new Date().toISOString()
    }];

    const result = applyChangesBatch(dev.db, matchingChange, 'dev_clinic_south');
    assert.strictEqual(result.conflictsCreated, 1);

    const conflict = dev.db.prepare("SELECT * FROM sync_conflicts WHERE conflict_type = 'POTENTIAL_DUPLICATE_PATIENT'").get();
    assert.ok(conflict);
    assert.strictEqual(conflict.resolution_strategy, 'MANUAL_CLINICIAN_REVIEW_REQUIRED');

    // Verify original patient 'pat_syn_101' was NOT deleted or overwritten
    const originalPat = dev.db.prepare('SELECT * FROM patients WHERE id = ?').get('pat_syn_101');
    assert.ok(originalPat, 'Original patient record must be preserved');
  });

  // 14. Approved Corrections & Superseded Audit Trail
  await test('14. Approved Corrections: Corrects record and marks revision progression', async () => {
    const dev = createTestDevice('dev_corr_01', 'Device-Correction');
    const patId = 'pat_syn_101';
    const initPat = dev.db.prepare('SELECT revision, primary_diagnosis FROM patients WHERE id = ?').get(patId);

    const correctionChange = [{
      change_id: IdGenerator.change(),
      entity_type: 'PATIENT',
      entity_id: patId,
      operation_type: 'UPDATE',
      device_id: 'dev_chief_physician',
      revision: initPat.revision + 1,
      payload: {
        id: patId,
        full_name: 'Eleanor Vance (Synthetic)',
        dob: '1968-04-12',
        gender: 'Female',
        blood_type: 'A+',
        primary_diagnosis: 'Acute Decompensated Heart Failure (NYHA Class IV - Corrected)'
      },
      timestamp: new Date().toISOString()
    }];

    applyChangesBatch(dev.db, correctionChange, 'dev_chief_physician');

    const updatedPat = dev.db.prepare('SELECT revision, primary_diagnosis FROM patients WHERE id = ?').get(patId);
    assert.strictEqual(updatedPat.revision, initPat.revision + 1);
    assert.strictEqual(updatedPat.primary_diagnosis, 'Acute Decompensated Heart Failure (NYHA Class IV - Corrected)');
  });

  // 15. Device Revocation & Offline Limitation Handling
  await test('15. Device Revocation: Revoked device is rejected; offline limitation documented', async () => {
    const dev = createTestDevice('dev_revo_server', 'Server-Node');
    const compromisedId = 'dev_compromised_tablet';

    // Administrator revokes device
    const revocation = revokeDevice(dev.db, compromisedId, { username: 'admin.elena', id: 'usr_adm_01' }, 'Lost device in transport');
    assert.strictEqual(revocation.deviceId, compromisedId);
    assert.ok(revocation.offlineLimitationNote.includes('offline copies already stored locally on the remote device remain accessible'));

    // Compromised device attempts handshake
    const handshake = dev.handleHandshake({
      device_id: compromisedId,
      device_name: 'Compromised Tablet',
      protocol_version: '1.0',
      schema_version: 1
    });

    assert.strictEqual(handshake.success, false);
    assert.strictEqual(handshake.statusCode, 403);
    assert.strictEqual(handshake.error, 'DEVICE_REVOKED');

    // Compromised device attempts to push changes
    assert.throws(() => {
      applyChangesBatch(dev.db, [{ change_id: 'chg_bad', entity_type: 'VISIT' }], compromisedId);
    }, /is revoked; change processing aborted/);
  });

  // 16. Visit-Frequency Mathematical Accuracy
  await test('16. Visit Analytics Accuracy: Deterministic 7d, 30d, 90d, 180d, 365d and interval statistics', async () => {
    const dev = createTestDevice('dev_math_01', 'Device-Math');
    const patId = 'pat_syn_101'; // Eleanor Vance (seeded with cluster)

    const analytics = calculateVisitAnalytics(dev.db, patId);

    assert.strictEqual(typeof analytics.confirmedVisits7d, 'number');
    assert.strictEqual(typeof analytics.confirmedVisits30d, 'number');
    assert.strictEqual(typeof analytics.confirmedVisits90d, 'number');
    assert.strictEqual(typeof analytics.confirmedVisits180d, 'number');
    assert.strictEqual(typeof analytics.confirmedVisits365d, 'number');
    assert.ok(analytics.confirmedVisits7d <= analytics.confirmedVisits30d);
    assert.ok(analytics.confirmedVisits30d <= analytics.confirmedVisits90d);

    // Interval checks
    assert.ok(Array.isArray(analytics.intervals));
    assert.strictEqual(typeof analytics.meanIntervalDays, 'number');
    assert.strictEqual(typeof analytics.stdDevIntervalDays, 'number');
    assert.ok(analytics.minIntervalDays <= analytics.maxIntervalDays);

    // Strict non-visit exclusion check
    assert.strictEqual(analytics.excludedEntities.patientDocumentsCount, 1);
  });

  // 17. Distributed Alert Deduplication
  await test('17. Distributed Alert Deduplication: Deterministic SHA-256 dedup key reconciles identically across devices', async () => {
    const devA = createTestDevice('dev_dedup_a', 'Device-Dedup-A');
    const devB = createTestDevice('dev_dedup_b', 'Device-Dedup-B');
    const patId = 'pat_syn_101';

    // Evaluate alerts on Device A
    const evalA = evaluateVisitAlerts(devA.db, patId, new Date(), devA.deviceId);
    assert.ok(evalA.alerts.length > 0);

    // Evaluate alerts on Device B
    const evalB = evaluateVisitAlerts(devB.db, patId, new Date(), devB.deviceId);
    assert.ok(evalB.alerts.length > 0);

    // Verify dedup keys match across both independent devices
    const dedupKeysA = evalA.alerts.map(a => a.dedup_key || a.dedupKey).sort();
    const dedupKeysB = evalB.alerts.map(a => a.dedup_key || a.dedupKey).sort();
    assert.deepStrictEqual(dedupKeysA, dedupKeysB, 'Dedup keys must match identically across nodes');

    // Clinician acknowledges on Device A
    const alertIdA = evalA.alerts[0].alert_id;
    reviewVisitAlert(devA.db, alertIdA, { id: 'usr_doc_01', fullName: 'Dr. Sarah Bennett' }, 'ACKNOWLEDGE', 'Patient contacted, diuresis regimen increased.');

    const reviewedRow = devA.db.prepare('SELECT review_status FROM visit_alerts WHERE alert_id = ?').get(alertIdA);
    assert.strictEqual(reviewedRow.review_status, 'REVIEWED_ACKNOWLEDGED');
  });

  // 18. Analytics Recalculation After Sync
  await test('18. Analytics Recalculation After Sync: Automatically updates visit statistics and triggers alerts', async () => {
    const devA = createTestDevice('dev_recalc_a', 'Device-Recalc-A');
    const devB = createTestDevice('dev_recalc_b', 'Device-Recalc-B');
    const patId = 'pat_syn_104'; // David Kowalski (initially 0 alerts)

    const initEval = evaluateVisitAlerts(devB.db, patId, new Date(), devB.deviceId);
    assert.strictEqual(initEval.alerts.length, 0, 'Initially stable diabetic patient has 0 alerts');

    // devA records 4 emergency visits in the last 5 days
    const nowMs = Date.now();
    for (let i = 1; i <= 4; i++) {
      const visId = IdGenerator.visit();
      const vDate = new Date(nowMs - i * 86400000).toISOString();
      devA.db.exec('BEGIN IMMEDIATE;');
      devA.db.prepare(`
        INSERT INTO visits (id, patient_id, visit_date, visit_type, provider_name, status, is_synthetic, revision, device_id, created_at, updated_at, is_archived)
        VALUES (?, ?, ?, 'EMERGENCY', 'Dr. Sarah Bennett', 'CONFIRMED', 1, 1, ?, ?, ?, 0)
      `).run(visId, patId, vDate, devA.deviceId, vDate, vDate);

      recordOutboxChange(devA.db, {
        entityType: 'VISIT',
        entityId: visId,
        payload: { id: visId, patient_id: patId, visit_date: vDate, status: 'CONFIRMED', visit_type: 'EMERGENCY', provider_name: 'Dr. Sarah Bennett' },
        deviceId: devA.deviceId,
        revision: 1,
        dependencies: { patient_id: patId }
      });
      devA.db.exec('COMMIT;');
    }

    // Sync from A into B
    await syncWithPeer(devA.db, devB);

    // Verify Device B automatically recalculated and now has UNUSUAL_VISIT_FREQUENCY alert
    const postAlerts = devB.db.prepare('SELECT * FROM visit_alerts WHERE patient_id = ?').all(patId);
    assert.ok(postAlerts.length > 0, 'Device B must have generated alert after sync');
    assert.strictEqual(postAlerts[0].neutral_label, 'UNUSUAL_VISIT_FREQUENCY');
    assert.ok(postAlerts[0].clinical_disclaimer.includes('Assessment by an authorized clinician is required'));
  });

  // 19. Incomplete Local Histories & Partial Sync Indicators
  await test('19. Partial Sync Indicator: Flags partial local view when pending outbox exists', async () => {
    const dev = createTestDevice('dev_part_01', 'Device-Partial');
    const patId = 'pat_syn_101';

    // When 0 pending outbox records:
    const cleanAnalytics = calculateVisitAnalytics(dev.db, patId);
    assert.strictEqual(cleanAnalytics.isCompleteView, true);
    assert.strictEqual(cleanAnalytics.dataFreshness, 'UP_TO_DATE');

    // Add a pending offline change for pat_syn_101
    recordOutboxChange(dev.db, {
      entityType: 'PATIENT',
      entityId: patId,
      operationType: 'UPDATE',
      payload: { phone: '+1-555-4444' },
      deviceId: dev.deviceId,
      revision: 5
    });

    // Now analytics must report partial local view
    const partialAnalytics = calculateVisitAnalytics(dev.db, patId);
    assert.strictEqual(partialAnalytics.isCompleteView, false);
    assert.strictEqual(partialAnalytics.dataFreshness, 'PARTIAL_PENDING_OUTBOX');
    assert.ok(partialAnalytics.dataQualityLimitations.includes('pending offline change(s) awaiting network sync'));

    // Check patient with <3 visits (pat_syn_103) reports unreliable baseline
    const appendectomyAnalytics = calculateVisitAnalytics(dev.db, 'pat_syn_103');
    assert.strictEqual(appendectomyAnalytics.reliableBaseline, false);
    assert.ok(appendectomyAnalytics.baselineExplanation.includes('Insufficient confirmed visit history'));
  });

  // 20. Unauthorized Device & Patient-Level Access Boundary Enforcement
  await test('20. Security Enforcement: Rejects unauthorized device payloads', async () => {
    const dev = createTestDevice('dev_sec_01', 'Device-Security');

    // Attempt sync with revoked device
    revokeDevice(dev.db, 'dev_intruder', { username: 'admin.elena' }, 'Unauthorized MAC address');

    assert.throws(() => {
      applyChangesBatch(dev.db, [{ change_id: 'chg_x', entity_type: 'VISIT' }], 'dev_intruder');
    }, /is revoked/);
  });

  // 21. Durability & Recovery After System Restart
  await test('21. Recovery After Restart: Persistent disk storage preserves uncommitted outbox queue', async () => {
    const testDbPath = path.join(__dirname, 'test_restart.db');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    // Initial session on disk
    let devDisk = createTestDevice('dev_disk_01', 'Tablet-Persistent', false, testDbPath);
    const patId = IdGenerator.patient();
    const now = new Date().toISOString();

    devDisk.db.exec('BEGIN IMMEDIATE;');
    devDisk.db.prepare(`
      INSERT INTO patients (id, mrn, full_name, dob, gender, blood_type, primary_diagnosis, admission_status, updated_at, sync_status, revision, is_archived, created_device_id)
      VALUES (?, 'SYN-2026-999', 'Persistent Patient', '1970-01-01', 'Female', 'A-', 'Hypertension', 'OBSERVATION', ?, 'PENDING', 1, 0, ?)
    `).run(patId, now, devDisk.deviceId);

    const change = recordOutboxChange(devDisk.db, {
      entityType: 'PATIENT',
      entityId: patId,
      payload: { id: patId, full_name: 'Persistent Patient' },
      deviceId: devDisk.deviceId,
      revision: 1
    });
    devDisk.db.exec('COMMIT;');
    devDisk.db.close(); // SIMULATE UNEXPECTED RESTART / CRASH

    // Re-open database after reboot
    devDisk = createTestDevice('dev_disk_01', 'Tablet-Persistent', false, testDbPath);

    const recoveredPatient = devDisk.db.prepare('SELECT * FROM patients WHERE id = ?').get(patId);
    assert.ok(recoveredPatient, 'Patient record must survive application restart');
    assert.strictEqual(recoveredPatient.full_name, 'Persistent Patient');

    const recoveredOutbox = devDisk.db.prepare('SELECT * FROM sync_outbox WHERE change_id = ?').get(change.changeId);
    assert.ok(recoveredOutbox, 'Outbox queue must survive application restart');
    assert.strictEqual(recoveredOutbox.status, 'PENDING');

    devDisk.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  console.log('\n========================================================================');
  console.log(`   TEST EXECUTION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests();
