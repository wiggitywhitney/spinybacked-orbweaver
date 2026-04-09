// ABOUTME: Express order route handler — creates an order for an existing user.
// ABOUTME: Real-world service module fixture for the JavaScript golden file test.

import express from 'express';
import { fetchUserById } from './services/user-service.js';
import { createOrder } from './services/order-service.js';

const router = express.Router();

router.post('/orders', async (req, res) => {
  const { userId, items } = req.body;

  const user = await fetchUserById(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const order = await createOrder({ userId, items });

  res.status(201).json({ orderId: order.id, status: order.status });
});

export default router;
