// ABOUTME: Test fixture — fraud detection service with domain-specific metrics.
// ABOUTME: Exercises schema extension creation: attributes like risk scores and check counts are not in the registry.
import { Pool } from 'pg';

const pool = new Pool();
const RISK_THRESHOLD = 0.75;

/**
 * Evaluate fraud risk for a transaction.
 * Combines multiple signal checks into a composite risk score.
 */
export async function evaluateFraudRisk(transaction) {
  const velocityScore = await checkTransactionVelocity(transaction.userId, transaction.amount);
  const geoScore = await checkGeolocationAnomaly(transaction.userId, transaction.ipAddress);
  const deviceScore = await checkDeviceFingerprint(transaction.deviceId);

  const compositeScore = (velocityScore * 0.4) + (geoScore * 0.35) + (deviceScore * 0.25);
  const flagged = compositeScore > RISK_THRESHOLD;

  if (flagged) {
    await recordFraudAlert(transaction.id, compositeScore);
  }

  return {
    transactionId: transaction.id,
    riskScore: compositeScore,
    flagged,
    checksPerformed: 3,
    signals: { velocityScore, geoScore, deviceScore },
  };
}

async function checkTransactionVelocity(userId, amount) {
  const result = await pool.query(
    'SELECT COUNT(*) as cnt, SUM(amount) as total FROM transactions WHERE user_id = $1 AND created_at > NOW() - INTERVAL \'1 hour\'',
    [userId],
  );
  const { cnt, total } = result.rows[0];
  if (cnt > 10 || total > 5000) return 0.9;
  if (cnt > 5 || total > 2000) return 0.5;
  return 0.1;
}

async function checkGeolocationAnomaly(userId, ipAddress) {
  const result = await pool.query(
    'SELECT country FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
    [userId],
  );
  const countries = new Set(result.rows.map(r => r.country));
  return countries.size > 2 ? 0.8 : 0.1;
}

async function checkDeviceFingerprint(deviceId) {
  const result = await pool.query(
    'SELECT first_seen, flagged_count FROM devices WHERE device_id = $1',
    [deviceId],
  );
  if (result.rows.length === 0) return 0.7; // Unknown device
  const { flagged_count } = result.rows[0];
  return flagged_count > 0 ? 0.6 : 0.1;
}

async function recordFraudAlert(transactionId, riskScore) {
  await pool.query(
    'INSERT INTO fraud_alerts (transaction_id, risk_score, created_at) VALUES ($1, $2, NOW())',
    [transactionId, riskScore],
  );
}
