// ABOUTME: TypeScript Express-like order handler fixture for golden file tests.
// ABOUTME: Demonstrates typed request/response parameters, async/await, and error handling.

import { trace, SpanStatusCode } from "@opentelemetry/api";

interface OrderBody {
  userId: string;
  items: string[];
}

interface ServiceRequest {
  body: OrderBody;
}

interface ServiceResponse {
  status(code: number): ServiceResponse;
  json(data: unknown): void;
}

async function fetchUserById(
  id: string,
): Promise<{ id: string; name: string } | null> {
  return id ? { id, name: "Test User" } : null;
}

async function createOrder(params: {
  userId: string;
  items: string[];
}): Promise<{ id: string; status: string }> {
  return { id: `order-${params.userId}`, status: "created" };
}

const tracer = trace.getTracer("order-service");

export async function handleCreateOrder(
  req: ServiceRequest,
  res: ServiceResponse,
): Promise<void> {
  return tracer.startActiveSpan("handleCreateOrder", async (span) => {
    try {
      const { userId, items } = req.body;

      const user = await fetchUserById(userId);
      if (!user) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        res.status(404).json({ error: "User not found" });
        return;
      }

      const order = await createOrder({ userId, items });
      span.setAttribute("order.id", order.id);
      span.setAttribute("order.status", order.status);
      res.status(201).json({ orderId: order.id, status: order.status });
    } catch (err: unknown) {
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
