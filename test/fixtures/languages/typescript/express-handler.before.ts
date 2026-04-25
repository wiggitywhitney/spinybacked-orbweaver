// ABOUTME: TypeScript Express-like order handler fixture for golden file tests.
// ABOUTME: Demonstrates typed request/response parameters, async/await, and error handling.

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

export async function handleCreateOrder(
  req: ServiceRequest,
  res: ServiceResponse,
): Promise<void> {
  const { userId, items } = req.body;

  const user = await fetchUserById(userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const order = await createOrder({ userId, items });
  res.status(201).json({ orderId: order.id, status: order.status });
}
