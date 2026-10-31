/**
 * CLINICAL PROTOTYPE - AUTOMATED AUTHENTICATION & RBAC TEST SUITE
 * 
 * Verifies all security and functional requirements:
 * 1. Role Selection & Authentication Separation
 * 2. Role Mismatch Detection & Rejection (HTTP 403 Forbidden)
 * 3. Backend RBAC Enforcement on Protected API Routes
 * 4. Audit Log Recording for Access Attempts & Security Events
 * 5. Invalidation on Logout & Role Switching Constraints
 * 6. Synthetic Patient Records Exclusivity
 * 7. Offline Synchronization Queue and Triggers
 */

const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const { server, db, initDatabase } = require('../server.js');

// Stream-based direct HTTP dispatcher (runs without network socket port binding)
function dispatch(method, url, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    let pushed = false;

    const req = new Readable({
      read() {
        if (!pushed) {
          if (payload) this.push(payload);
          this.push(null);
          pushed = true;
        }
      }
    });

    req.method = method;
    req.url = url;
    req.headers = {
      host: 'localhost',
      'content-type': 'application/json'
    };
    if (token) {
      req.headers['authorization'] = `Bearer ${token}`;
    }
    req.socket = { remoteAddress: '127.0.0.1' };

    let resBody = '';
    const res = new Writable({
      write(chunk, enc, cb) {
        resBody += chunk;
        cb();
      }
    });

    res.statusCode = 200;
    res.headers = {};
    res.writeHead = function (code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
      return res;
    };

    res.end = function (chunk) {
      if (chunk) resBody += chunk;
      let json = null;
      try {
        json = resBody ? JSON.parse(resBody) : {};
      } catch (e) {
        json = { raw: resBody };
      }
      resolve({ status: res.statusCode, headers: res.headers, data: json });
    };

    server.emit('request', req, res);
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('   CLINICAL PROTOTYPE AUTH & RBAC VERIFICATION TEST SUITE       ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err.message || err);
      failed++;
    }
  }

  // 1. GET /api/auth/demo-accounts
  await test('1. GET /api/auth/demo-accounts returns predefined demo accounts with synthetic notice', async () => {
    const res = await dispatch('GET', '/api/auth/demo-accounts');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.isPrototypeDemo, true);
    assert.strictEqual(res.data.accounts.length, 3);
    assert.ok(res.data.notice.includes('SYNTHETIC DATA ONLY'));
    const roles = res.data.accounts.map(a => a.role);
    assert.deepStrictEqual(roles.sort(), ['ADMINISTRATOR', 'DOCTOR', 'NURSE']);
  });

  // 2. Successful Doctor login with matching role
  let doctorToken = null;
  await test('2. POST /api/auth/login succeeds when selected role matches authorized role (DOCTOR)', async () => {
    const res = await dispatch('POST', '/api/auth/login', {
      username: 'dr.sarah',
      password: 'DoctorPass2026!',
      selected_role: 'DOCTOR'
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.token, 'Should return session token');
    assert.strictEqual(res.data.user.role, 'DOCTOR');
    assert.strictEqual(res.data.user.username, 'dr.sarah');
    doctorToken = res.data.token;
  });

  // 3. CRITICAL SECURITY: Role Mismatch Rejection
  // "A user must not gain doctor or administrator permissions merely by changing the selected role in the frontend.
  // If the selected role does not match the authenticated user's authorized role, reject the login attempt or require the user to select their authorized role."
  await test('3. POST /api/auth/login rejects login when selected role mismatches user authorized role', async () => {
    // dr.sarah is DOCTOR, but user chooses NURSE
    const res = await dispatch('POST', '/api/auth/login', {
      username: 'dr.sarah',
      password: 'DoctorPass2026!',
      selected_role: 'NURSE'
    });
    assert.strictEqual(res.status, 403, 'Must return HTTP 403 Forbidden');
    assert.strictEqual(res.data.code, 'ROLE_MISMATCH');
    assert.strictEqual(res.data.authorizedRole, 'DOCTOR');
    assert.strictEqual(res.data.selectedRole, 'NURSE');
    assert.ok(res.data.error.includes('Role Mismatch'));
  });

  // 4. Role Mismatch for Nurse choosing Administrator
  await test('4. POST /api/auth/login rejects Nurse attempting Administrator role', async () => {
    const res = await dispatch('POST', '/api/auth/login', {
      username: 'nurse.james',
      password: 'NursePass2026!',
      selected_role: 'ADMINISTRATOR'
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.code, 'ROLE_MISMATCH');
    assert.strictEqual(res.data.authorizedRole, 'NURSE');
    assert.strictEqual(res.data.selectedRole, 'ADMINISTRATOR');
  });

  // 5. Successful Nurse Login
  let nurseToken = null;
  await test('5. POST /api/auth/login succeeds for Nurse with matching role', async () => {
    const res = await dispatch('POST', '/api/auth/login', {
      username: 'nurse.james',
      password: 'NursePass2026!',
      selected_role: 'NURSE'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.user.role, 'NURSE');
    nurseToken = res.data.token;
  });

  // 6. Successful Administrator Login
  let adminToken = null;
  await test('6. POST /api/auth/login succeeds for Administrator with matching role', async () => {
    const res = await dispatch('POST', '/api/auth/login', {
      username: 'admin.elena',
      password: 'AdminPass2026!',
      selected_role: 'ADMINISTRATOR'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.user.role, 'ADMINISTRATOR');
    adminToken = res.data.token;
  });

  // 7. RBAC Protection: Doctor cannot access Administrator endpoints
  await test('7. RBAC: Doctor token rejected on /api/admin/users with HTTP 403', async () => {
    const res = await dispatch('GET', '/api/admin/users', null, doctorToken);
    assert.strictEqual(res.status, 403);
    assert.ok(res.data.error.includes('Access denied'));
  });

  // 8. RBAC Protection: Nurse cannot access Doctor consultation creation
  await test('8. RBAC: Nurse token rejected on /api/doctor/consultations with HTTP 403', async () => {
    const res = await dispatch('POST', '/api/doctor/consultations', {
      patient_id: 'pat_syn_101',
      assessment: 'Nurse assessment attempt',
      treatment_plan: 'Plan'
    }, nurseToken);
    assert.strictEqual(res.status, 403);
    assert.ok(res.data.error.includes('Access denied'));
  });

  // 9. Doctor clinical functions succeed
  await test('9. Doctor can order medication and view synthetic patients', async () => {
    const patientsRes = await dispatch('GET', '/api/patients', null, doctorToken);
    assert.strictEqual(patientsRes.status, 200);
    assert.strictEqual(patientsRes.data.isSyntheticData, true);

    const medRes = await dispatch('POST', '/api/doctor/medications', {
      patient_id: 'pat_syn_101',
      medication_name: 'Metoprolol Tartrate',
      dosage: '25 mg',
      route: 'Oral',
      frequency: 'BID'
    }, doctorToken);
    assert.strictEqual(medRes.status, 201);
    assert.ok(medRes.data.orderId);
  });

  // 10. Nurse can access tasks & observations
  await test('10. Nurse can fetch assigned medication tasks and submit observations', async () => {
    const tasksRes = await dispatch('GET', '/api/nurse/tasks', null, nurseToken);
    assert.strictEqual(tasksRes.status, 200);
    assert.ok(Array.isArray(tasksRes.data.tasks));

    const obsRes = await dispatch('POST', '/api/nurse/observations', {
      patient_id: 'pat_syn_101',
      bp_systolic: 124,
      bp_diastolic: 82,
      heart_rate: 76,
      spo2: 98,
      intake_ml: 400,
      output_ml: 450,
      observation_notes: 'Vital signs stable during evening check'
    }, nurseToken);
    assert.strictEqual(obsRes.status, 201);
  });

  // 11. Admin can view audit logs and verify role mismatch events
  await test('11. Administrator can query audit logs & verify role mismatch events', async () => {
    const auditRes = await dispatch('GET', '/api/admin/audit-logs', null, adminToken);
    assert.strictEqual(auditRes.status, 200);
    assert.ok(auditRes.data.logs.length > 0);

    // Verify that ROLE_MISMATCH event was recorded
    const mismatchEvent = auditRes.data.logs.find(l => l.status === 'MISMATCH');
    assert.ok(mismatchEvent, 'Audit log must record role mismatch attempt');
    assert.strictEqual(mismatchEvent.action, 'ROLE_MISMATCH_REJECTION');

    // Verify that FORBIDDEN_ROLE_ACCESS event was recorded
    const deniedEvent = auditRes.data.logs.find(l => l.action === 'FORBIDDEN_ROLE_ACCESS');
    assert.ok(deniedEvent, 'Audit log must record RBAC unauthorized access attempt');
  });

  // 12. Logout terminates session
  await test('12. POST /api/auth/logout invalidates session token immediately', async () => {
    const logoutRes = await dispatch('POST', '/api/auth/logout', null, doctorToken);
    assert.strictEqual(logoutRes.status, 200);

    // Subsequent call using doctorToken must now return 401 Unauthorized
    const followUp = await dispatch('GET', '/api/patients', null, doctorToken);
    assert.strictEqual(followUp.status, 401);
    assert.ok(followUp.data.error.includes('Authentication required'));
  });

  // 13. Offline synchronization status query & manual sync cycle
  await test('13. Offline synchronization status query & manual sync cycle', async () => {
    const syncStatus = await dispatch('GET', '/api/admin/sync-status', null, adminToken);
    assert.strictEqual(syncStatus.status, 200);
    assert.strictEqual(syncStatus.data.syncEngine, 'HYBRID_OFFLINE_CAPABLE');

    const triggerRes = await dispatch('POST', '/api/admin/sync-now', null, adminToken);
    assert.strictEqual(triggerRes.status, 200);
  });

  console.log(`\n================================================================`);
  console.log(`   TEST EXECUTION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log(`================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
