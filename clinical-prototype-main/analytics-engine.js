/**
 * VISIT-FREQUENCY ANALYTICS & DISTRIBUTED ALERT ENGINE
 * 
 * Offline-first, deterministic clinical visit analytics engine providing:
 * - Confirmed visit windows (7d, 30d, 90d, 180d, 365d)
 * - Historical visit intervals (mean, standard deviation, min, max)
 * - Recent frequency acceleration vs historical baseline
 * - Insufficient baseline safeguards (<3 visits or <30d span)
 * - Explainable UNUSUAL_VISIT_FREQUENCY alerts
 * - Distributed alert deduplication (deterministic hash keys)
 * - Partial synchronization & data freshness indicators
 * - Clinician review audit trail
 */

const crypto = require('node:crypto');

// Default configurable thresholds (can be overridden from clinic_settings)
const DEFAULT_THRESHOLDS = {
  shortWindowDays: 7,
  shortWindowThreshold: 3,
  monthWindowDays: 30,
  monthWindowThreshold: 5,
  deviationMultiplier: 2.5
};

/**
 * Load analytics configuration from clinic_settings table
 */
function getAnalyticsConfig(db) {
  const config = { ...DEFAULT_THRESHOLDS };
  try {
    const rows = db.prepare("SELECT key, value FROM clinic_settings WHERE category = 'ANALYTICS'").all();
    for (const row of rows) {
      if (row.key === 'analytics.short_window_days') config.shortWindowDays = parseInt(row.value, 10);
      if (row.key === 'analytics.short_window_threshold') config.shortWindowThreshold = parseInt(row.value, 10);
      if (row.key === 'analytics.month_window_days') config.monthWindowDays = parseInt(row.value, 10);
      if (row.key === 'analytics.month_window_threshold') config.monthWindowThreshold = parseInt(row.value, 10);
      if (row.key === 'analytics.deviation_multiplier') config.deviationMultiplier = parseFloat(row.value);
    }
  } catch (err) {
    // If table doesn't have ANALYTICS rows yet, fallback to defaults
  }
  return config;
}

/**
 * Calculate deterministic visit-frequency analytics for a given patient.
 * 
 * Strict invariants:
 * - ONLY Confirmed visits ('CONFIRMED') are counted.
 * - Uploaded documents, chatbot messages, nursing observations, and consultations are STRICTLY EXCLUDED.
 * - Time calculations use UTC milliseconds.
 * - Where historical data is insufficient (<3 visits or <30d span), indicates baseline is unreliable.
 * 
 * @param {object} db - DatabaseSync instance
 * @param {string} patientId - Target patient ID
 * @param {Date|string} asOfDate - Baseline calculation reference point (defaults to now)
 */
function calculateVisitAnalytics(db, patientId, asOfDate = new Date()) {
  const asOf = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const asOfMs = asOf.getTime();

  // 1. Fetch all confirmed, non-archived visits for patient, sorted chronologically
  const visits = db.prepare(`
    SELECT id, patient_id, visit_date, visit_type, provider_name, department, chief_complaint, status
    FROM visits
    WHERE patient_id = ? AND status = 'CONFIRMED' AND is_archived = 0
    ORDER BY visit_date ASC
  `).all(patientId);

  // 2. Fetch counts of non-visit records to document exclusions explicitly
  let unconfirmedVisitsCount = 0;
  let patientDocumentsCount = 0;
  try {
    unconfirmedVisitsCount = db.prepare(`
      SELECT COUNT(*) AS count FROM visits WHERE patient_id = ? AND status != 'CONFIRMED' AND is_archived = 0
    `).get(patientId)?.count || 0;
  } catch (e) {}

  try {
    patientDocumentsCount = db.prepare(`
      SELECT COUNT(*) AS count FROM documents WHERE patient_id = ? AND is_archived = 0
    `).get(patientId)?.count || 0;
  } catch (e) {}

  // 3. Filter visits occurring before or at asOfMs
  const eligibleVisits = visits.filter(v => {
    const vTime = new Date(v.visit_date).getTime();
    return !isNaN(vTime) && vTime <= asOfMs;
  });

  const totalConfirmedVisits = eligibleVisits.length;

  // Window calculations
  const ms7d = 7 * 86400000;
  const ms30d = 30 * 86400000;
  const ms90d = 90 * 86400000;
  const ms180d = 180 * 86400000;
  const ms365d = 365 * 86400000;

  const visitsInWindow = (windowMs) => eligibleVisits.filter(v => {
    const vTime = new Date(v.visit_date).getTime();
    return vTime >= (asOfMs - windowMs) && vTime <= asOfMs;
  });

  const visits7dList = visitsInWindow(ms7d);
  const visits30dList = visitsInWindow(ms30d);
  const visits90dList = visitsInWindow(ms90d);
  const visits180dList = visitsInWindow(ms180d);
  const visits365dList = visitsInWindow(ms365d);

  // Time since previous visit
  let timeSincePreviousVisitDays = null;
  let lastVisit = null;
  if (totalConfirmedVisits > 0) {
    lastVisit = eligibleVisits[totalConfirmedVisits - 1];
    const lastVisitMs = new Date(lastVisit.visit_date).getTime();
    timeSincePreviousVisitDays = Math.max(0, parseFloat(((asOfMs - lastVisitMs) / 86400000).toFixed(1)));
  }

  // Consecutive intervals (in days)
  const intervals = [];
  for (let i = 1; i < totalConfirmedVisits; i++) {
    const prevMs = new Date(eligibleVisits[i - 1].visit_date).getTime();
    const currMs = new Date(eligibleVisits[i].visit_date).getTime();
    const intervalDays = parseFloat(((currMs - prevMs) / 86400000).toFixed(1));
    intervals.push(intervalDays);
  }

  let meanIntervalDays = null;
  let stdDevIntervalDays = null;
  let minIntervalDays = null;
  let maxIntervalDays = null;

  if (intervals.length > 0) {
    const sum = intervals.reduce((acc, val) => acc + val, 0);
    meanIntervalDays = parseFloat((sum / intervals.length).toFixed(1));
    const squaredDiffs = intervals.map(val => Math.pow(val - meanIntervalDays, 2));
    const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / intervals.length;
    stdDevIntervalDays = parseFloat(Math.sqrt(variance).toFixed(1));
    minIntervalDays = Math.min(...intervals);
    maxIntervalDays = Math.max(...intervals);
  }

  // Baseline reliability & recent frequency acceleration
  let reliableBaseline = false;
  let baselineExplanation = '';
  let baselineMonthlyFrequency = null;
  let recent30dFrequencyPerMonth = visits30dList.length;
  let frequencyAccelerationFactor = null;

  if (totalConfirmedVisits >= 3) {
    const firstVisitMs = new Date(eligibleVisits[0].visit_date).getTime();
    const totalObservationSpanDays = (asOfMs - firstVisitMs) / 86400000;

    if (totalObservationSpanDays >= 30) {
      reliableBaseline = true;
      // Monthly baseline rate = (total confirmed visits / span in days) * 30 days
      baselineMonthlyFrequency = parseFloat(((totalConfirmedVisits / totalObservationSpanDays) * 30).toFixed(2));
      baselineExplanation = `Reliable historical baseline established across ${totalConfirmedVisits} confirmed visits over ${Math.round(totalObservationSpanDays)} days.`;

      if (baselineMonthlyFrequency > 0) {
        frequencyAccelerationFactor = parseFloat((recent30dFrequencyPerMonth / baselineMonthlyFrequency).toFixed(2));
      }
    } else {
      reliableBaseline = false;
      baselineExplanation = `Total observation span is under 30 days (${Math.round(totalObservationSpanDays)} days); insufficient observation window to compute reliable baseline.`;
    }
  } else {
    reliableBaseline = false;
    baselineExplanation = `Insufficient confirmed visit history (${totalConfirmedVisits} visits). Reliable historical baseline requires at least 3 confirmed visits.`;
  }

  // 4. Data Freshness & Completeness Inspection
  let pendingOutboxCount = 0;
  try {
    const outboxRow = db.prepare(`
      SELECT COUNT(*) AS count FROM sync_outbox
      WHERE status = 'PENDING' AND (entity_id = ? OR dependencies LIKE ?)
    `).get(patientId, `%"patient_id":"${patientId}"%`);
    pendingOutboxCount = outboxRow ? outboxRow.count : 0;
  } catch (e) {}

  const isCompleteView = pendingOutboxCount === 0;
  const dataFreshness = isCompleteView ? 'UP_TO_DATE' : 'PARTIAL_PENDING_OUTBOX';
  const dataQualityLimitations = isCompleteView
    ? 'All local records fully synchronized. Non-visit documents, unconfirmed orders, and planned visits are excluded.'
    : `Local device has ${pendingOutboxCount} pending offline change(s) awaiting network sync. Analysis reflects current local node view only.`;

  return {
    patientId,
    asOfDate: asOf.toISOString(),
    totalConfirmedVisits,
    confirmedVisits7d: visits7dList.length,
    confirmedVisits30d: visits30dList.length,
    confirmedVisits90d: visits90dList.length,
    confirmedVisits180d: visits180dList.length,
    confirmedVisits365d: visits365dList.length,
    timeSincePreviousVisitDays,
    lastVisitDate: lastVisit ? lastVisit.visit_date : null,
    intervals,
    meanIntervalDays,
    stdDevIntervalDays,
    minIntervalDays,
    maxIntervalDays,
    recent30dFrequencyPerMonth,
    baselineMonthlyFrequency,
    frequencyAccelerationFactor,
    reliableBaseline,
    baselineExplanation,
    isCompleteView,
    dataFreshness,
    pendingOutboxCount,
    dataQualityLimitations,
    excludedEntities: {
      unconfirmedVisitsCount,
      patientDocumentsCount,
      chatbotMessagesCount: 0
    },
    supportingVisits: {
      last7d: visits7dList,
      last30d: visits30dList
    }
  };
}

/**
 * Generate a deterministic deduplication key for distributed alerts
 */
function generateAlertDedupKey(patientId, ruleName, supportingVisitIds) {
  const sortedIds = [...supportingVisitIds].sort().join(',');
  return crypto.createHash('sha256').update(`${patientId}:${ruleName}:${sortedIds}`).digest('hex');
}

/**
 * Evaluate configurable rules and generate or update UNUSUAL_VISIT_FREQUENCY alerts.
 * 
 * Rules:
 * 1. MULTIPLE_VISITS_SHORT_PERIOD: >= shortWindowThreshold confirmed visits in shortWindowDays (default: >=3 in 7d)
 * 2. HIGH_RECENT_FREQUENCY: >= monthWindowThreshold confirmed visits in monthWindowDays (default: >=5 in 30d)
 * 3. SUBSTANTIAL_BASELINE_DEVIATION: 30-day frequency exceeds baseline by deviationMultiplier (default: >2.5x)
 * 
 * @param {object} db - DatabaseSync instance
 * @param {string} patientId - Target patient ID
 * @param {Date|string} asOfDate - Evaluation date
 * @param {string} deviceId - Local device installation ID
 */
function evaluateVisitAlerts(db, patientId, asOfDate = new Date(), deviceId = 'local-device') {
  const config = getAnalyticsConfig(db);
  const analytics = calculateVisitAnalytics(db, patientId, asOfDate);
  const nowIso = new Date().toISOString();
  const generatedAlerts = [];

  const clinicalDisclaimer = 'This alert identifies unusual visit patterns and does not indicate disease severity or clinical deterioration. Assessment by an authorized clinician is required before altering patient care.';

  // Rule 1: Multiple confirmed visits within short period
  if (analytics.confirmedVisits7d >= config.shortWindowThreshold) {
    const visitIds = analytics.supportingVisits.last7d.map(v => v.id);
    const dedupKey = generateAlertDedupKey(patientId, 'MULTIPLE_VISITS_SHORT_PERIOD', visitIds);
    
    generatedAlerts.push({
      dedupKey,
      patientId,
      ruleName: 'MULTIPLE_VISITS_SHORT_PERIOD',
      ruleVersion: '1.0',
      observationWindow: `LAST_${config.shortWindowDays}_DAYS`,
      confirmedVisitsCount: analytics.confirmedVisits7d,
      historicalBaseline: JSON.stringify({
        meanIntervalDays: analytics.meanIntervalDays,
        reliableBaseline: analytics.reliableBaseline
      }),
      supportingVisitIds: JSON.stringify(analytics.supportingVisits.last7d.map(v => ({ id: v.id, date: v.visit_date, type: v.visit_type }))),
      dataQualityLimitations: analytics.dataQualityLimitations,
      neutralLabel: 'UNUSUAL_VISIT_FREQUENCY',
      deviceId,
      clinicalDisclaimer,
      explanation: `Patient had ${analytics.confirmedVisits7d} confirmed visits within ${config.shortWindowDays} days (Configured threshold: >= ${config.shortWindowThreshold}).`
    });
  }

  // Rule 2: High recent visit frequency
  if (analytics.confirmedVisits30d >= config.monthWindowThreshold) {
    const visitIds = analytics.supportingVisits.last30d.map(v => v.id);
    const dedupKey = generateAlertDedupKey(patientId, 'HIGH_RECENT_FREQUENCY', visitIds);

    generatedAlerts.push({
      dedupKey,
      patientId,
      ruleName: 'HIGH_RECENT_FREQUENCY',
      ruleVersion: '1.0',
      observationWindow: `LAST_${config.monthWindowDays}_DAYS`,
      confirmedVisitsCount: analytics.confirmedVisits30d,
      historicalBaseline: JSON.stringify({
        baselineMonthlyFrequency: analytics.baselineMonthlyFrequency,
        reliableBaseline: analytics.reliableBaseline
      }),
      supportingVisitIds: JSON.stringify(analytics.supportingVisits.last30d.map(v => ({ id: v.id, date: v.visit_date, type: v.visit_type }))),
      dataQualityLimitations: analytics.dataQualityLimitations,
      neutralLabel: 'UNUSUAL_VISIT_FREQUENCY',
      deviceId,
      clinicalDisclaimer,
      explanation: `Patient had ${analytics.confirmedVisits30d} confirmed visits within ${config.monthWindowDays} days (Configured threshold: >= ${config.monthWindowThreshold}).`
    });
  }

  // Rule 3: Substantial deviation from historical visit pattern
  if (
    analytics.reliableBaseline &&
    analytics.baselineMonthlyFrequency > 0 &&
    analytics.confirmedVisits30d >= 3 &&
    analytics.frequencyAccelerationFactor >= config.deviationMultiplier
  ) {
    const visitIds = analytics.supportingVisits.last30d.map(v => v.id);
    const dedupKey = generateAlertDedupKey(patientId, 'SUBSTANTIAL_BASELINE_DEVIATION', visitIds);

    generatedAlerts.push({
      dedupKey,
      patientId,
      ruleName: 'SUBSTANTIAL_BASELINE_DEVIATION',
      ruleVersion: '1.0',
      observationWindow: `LAST_${config.monthWindowDays}_DAYS`,
      confirmedVisitsCount: analytics.confirmedVisits30d,
      historicalBaseline: JSON.stringify({
        baselineMonthlyFrequency: analytics.baselineMonthlyFrequency,
        meanIntervalDays: analytics.meanIntervalDays,
        accelerationFactor: analytics.frequencyAccelerationFactor,
        reliableBaseline: true
      }),
      supportingVisitIds: JSON.stringify(analytics.supportingVisits.last30d.map(v => ({ id: v.id, date: v.visit_date, type: v.visit_type }))),
      dataQualityLimitations: analytics.dataQualityLimitations,
      neutralLabel: 'UNUSUAL_VISIT_FREQUENCY',
      deviceId,
      clinicalDisclaimer,
      explanation: `Recent visit frequency (${analytics.recent30dFrequencyPerMonth} visits/mo) is ${analytics.frequencyAccelerationFactor}x the historical baseline (${analytics.baselineMonthlyFrequency} visits/mo), exceeding deviation threshold (${config.deviationMultiplier}x).`
    });
  }

  // Persist / Reconcile alerts in SQLite without destroying provenance or clinician reviews
  const activeAlerts = [];
  for (const alert of generatedAlerts) {
    const existing = db.prepare('SELECT * FROM visit_alerts WHERE dedup_key = ?').get(alert.dedupKey);
    if (existing) {
      // Reconcile without overwriting clinician review
      db.prepare(`
        UPDATE visit_alerts
        SET confirmed_visits_count = ?,
            data_quality_limitations = ?,
            historical_baseline = ?
        WHERE dedup_key = ?
      `).run(alert.confirmedVisitsCount, alert.dataQualityLimitations, alert.historicalBaseline, alert.dedupKey);

      activeAlerts.push({
        ...existing,
        confirmed_visits_count: alert.confirmedVisitsCount,
        data_quality_limitations: alert.dataQualityLimitations,
        explanation: alert.explanation
      });
    } else {
      const alertId = 'alt_' + crypto.randomUUID();
      db.prepare(`
        INSERT INTO visit_alerts (
          alert_id, dedup_key, patient_id, rule_name, rule_version, observation_window,
          confirmed_visits_count, historical_baseline, supporting_visit_ids, data_quality_limitations,
          neutral_label, device_id, created_at, review_status, review_history,
          clinical_assessment_notes, clinical_disclaimer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_CLINICIAN_REVIEW', '[]', '', ?)
      `).run(
        alertId, alert.dedupKey, alert.patientId, alert.ruleName, alert.ruleVersion,
        alert.observationWindow, alert.confirmedVisitsCount, alert.historicalBaseline,
        alert.supportingVisitIds, alert.dataQualityLimitations, alert.neutralLabel,
        alert.deviceId, nowIso, alert.clinicalDisclaimer
      );

      activeAlerts.push({
        alert_id: alertId,
        ...alert,
        review_status: 'PENDING_CLINICIAN_REVIEW',
        review_history: '[]',
        clinical_assessment_notes: ''
      });
    }
  }

  return {
    analytics,
    alerts: activeAlerts
  };
}

/**
 * Record clinician review of an unusual visit frequency alert.
 */
function reviewVisitAlert(db, alertId, clinicianUser, action, notes) {
  const alert = db.prepare('SELECT * FROM visit_alerts WHERE alert_id = ?').get(alertId);
  if (!alert) {
    throw new Error('Alert not found.');
  }

  const normalizedAction = action.toUpperCase().trim();
  const newStatus = normalizedAction === 'ACKNOWLEDGE' ? 'REVIEWED_ACKNOWLEDGED' : 'DISMISSED';
  const now = new Date().toISOString();

  let history = [];
  try {
    history = JSON.parse(alert.review_history || '[]');
  } catch (e) {}

  history.push({
    action: newStatus,
    clinicianId: clinicianUser.id,
    clinicianName: clinicianUser.fullName || clinicianUser.full_name || clinicianUser.username,
    timestamp: now,
    notes: notes || 'Clinician assessed visit frequency pattern.'
  });

  db.prepare(`
    UPDATE visit_alerts
    SET review_status = ?,
        review_history = ?,
        clinical_assessment_notes = ?
    WHERE alert_id = ?
  `).run(newStatus, JSON.stringify(history), notes || '', alertId);

  return {
    alertId,
    reviewStatus: newStatus,
    reviewHistory: history,
    updatedAt: now
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  getAnalyticsConfig,
  calculateVisitAnalytics,
  generateAlertDedupKey,
  evaluateVisitAlerts,
  reviewVisitAlert
};
