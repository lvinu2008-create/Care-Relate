# Clinical Portal Prototype — Role Selection & Authorization

A prototype clinical management application demonstrating **Role Selection**, **Authentication**, **Server-Enforced Role-Based Access Control (RBAC)**, and **Audit Trail Compliance**.

> **DEMO ENVIRONMENT NOTICE:**
> This system is an evaluative prototype operating exclusively on synthetic clinical records. All patients, diagnoses, medications, and audit records are synthetic and designated for demonstration purposes only.

---

## 1. Key Architectural Principles

### Separation of Role Selection vs. Authorization
- **Role Selection** on the login screen allows the evaluator to express their *requested interface* (Doctor, Nurse, Administrator).
- **Backend Authorization** strictly verifies that the authenticated user's actual database-enforced role matches the requested role.
- **Security Control**: A user **cannot** obtain elevated Doctor or Administrator permissions simply by selecting that role in the frontend. If a role mismatch is detected (e.g. attempting to log into a Doctor account while selecting Nurse), the server rejects the request with `HTTP 403 Forbidden` (`ROLE_MISMATCH`) and logs the event to the tamper-evident audit log.
- **Role Switching**: Users cannot switch roles on the fly after logging in. They must explicitly log out, which invalidates the cryptographic session token and returns them to the role-selection login screen.

---

## 2. Predefined Demo Accounts

Predefined demo accounts are configured with salted PBKDF2 credential hashes for quick prototype evaluation without requiring a full user onboarding setup:

| Role | Username | Password | Full Name | Staff ID | Authorized Scope |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Doctor** | `dr.sarah` | `DoctorPass2026!` | Dr. Sarah Bennett, MD | `DOC-8821` | Patient search, medical history, consultations, medication orders, review flags |
| **Nurse** | `nurse.james` | `NursePass2026!` | James Rodriguez, RN | `NUR-4419` | Medication administration (eMAR), vitals & observations, care record updates |
| **Administrator** | `admin.elena` | `AdminPass2026!` | Elena Rostova, MHA | `ADM-1002` | User management, role configuration, clinic settings, devices, sync, audit logs |

> **Evaluator Convenience:** The login screen provides **one-click quick-fill buttons** to immediately load any of these demo profiles, along with a dedicated **"Test Role Mismatch Security"** button to observe immediate server rejection.

---

## 3. Role-Based Navigation & Dashboards

### 🩺 Doctor Dashboard
- **Patient Directory & Search:** Real-time lookup by name, MRN, room, or clinical diagnosis.
- **Clinical Review Flags:** Triage queue of patients flagged for physician attention with one-click flag toggles.
- **Patient Chart & Medical History:** Synthetic patient overview including blood type, allergies alert banner, and clinical history.
- **Consultations Module:** Review historical consultation notes and write new consultations (chief complaint, clinical assessment, treatment plan).
- **Medication Orders:** Prescribe medications (dosage, route, frequency) with automatic routing into nursing task queues.

### 💉 Nurse Dashboard
- **Medication Administration Tasks (eMAR):** Scheduled medications list with allergy check alerts, five-rights verification notes, and one-click administration logging.
- **Nursing Observations:** Record vital signs (Systolic/Diastolic BP, Heart Rate, Respiratory Rate, SpO2, Temperature °C) and Fluid Balance (Intake / Output mL).
- **Authorized Patient Information:** Bedside care overview and shift progress note recording.

### 🛡️ Administrator Dashboard
- **Staff User Management:** View accounts, create new staff users, and toggle active/inactive status.
- **Role Configuration Matrix:** Full interactive access control matrix documenting server-enforced permissions.
- **Clinic Settings:** Configure emergency contact numbers, session inactivity timeouts, sync intervals, and compliance policies.
- **Device Management:** Monitor connected bedside tablets, mobile fleet devices, and workstation terminals.
- **Synchronization Status:** Monitor offline sync queue, pending payloads, and trigger manual replication cycles.
- **Audit Logs:** Tamper-evident log of all authentication attempts, role mismatches, data access, and administrative modifications.

---

## 4. Running the Application & Tests

### Start the Server
```powershell
node server.js
```
The server will initialize the SQLite database (`clinical_prototype.db`), seed synthetic records and demo accounts, and listen at `http://127.0.0.1:3000`.

### Run Automated Security & Auth Test Suite
```powershell
node test/auth-test.js
```
The automated test suite verifies:
1. Retrieval of predefined demo accounts with synthetic disclosure.
2. Successful authentication for Doctor, Nurse, and Administrator accounts with matching roles.
3. Strict server rejection (HTTP 403) of role mismatch attempts.
4. RBAC boundary enforcement (Doctor blocked from Admin APIs, Nurse blocked from Doctor APIs).
5. Generation of audit log entries for all security, authentication, and mismatch events.
6. Immediate session invalidation upon logout (subsequent API calls return HTTP 401).
7. Offline synchronization queue operations.

---

## 5. File Structure
```
clinical-prototype/
├── server.js              # Node.js HTTP server, node:sqlite database, RBAC middleware & audit logger
├── package.json           # Project manifest
├── README.md              # System documentation & evaluation guide
├── test/
│   └── auth-test.js       # 13-point automated security & RBAC verification suite
└── public/
    ├── index.html         # Role selection screen & mobile-friendly role dashboards
    ├── css/
    │   └── styles.css     # Clean healthcare UI design system
    └── js/
        └── app.js         # Frontend controller, role navigation & API interaction
```
