// ABOUTME: Test fixture — order processing service with fetch calls.
// ABOUTME: Tests external HTTP calls (COV-002) and existing error handling (NDS-005).
const API_BASE = process.env.PAYMENT_API_URL || 'https://api.payments.example.com';

export async function processOrder(order) {
  const validated = validateOrder(order);
  const payment = await chargePayment(validated);
  return { orderId: order.id, paymentId: payment.id, status: 'completed' };
}

export async function chargePayment(order) {
  const response = await fetch(`${API_BASE}/charges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: order.total, currency: 'usd' }),
  });
  if (!response.ok) {
    throw new Error(`Payment failed: ${response.status}`);
  }
  return await response.json();
}

function validateOrder(order) {
  if (!order.id || !order.total) {
    throw new Error('Invalid order: missing id or total');
  }
  if (order.total <= 0) {
    throw new Error('Invalid order: total must be positive');
  }
  return order;
}
