// ABOUTME: Express order route handler — creates an order for an existing user.
// ABOUTME: Real-world service module fixture for the JavaScript golden file test.

import express from 'express';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { fetchUserById } from './services/user-service.js';
import { createOrder } from './services/order-service.js';

const router = express.Router();
const tracer = trace.getTracer('order-service');

router.post('/orders', async (req, res) => {
  return tracer.startActiveSpan('POST /orders', async (span) => {
    try {
      const { userId, items } = req.body;

      const user = await fetchUserById(userId);
      if (!user) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'User not found' });
        span.end();
        return res.status(404).json({ error: 'User not found' });
      }

      const order = await createOrder({ userId, items });

      span.setAttribute('order.id', order.id);
      span.setAttribute('order.status', order.status);
      res.status(201).json({ orderId: order.id, status: order.status });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
});

export default router;
