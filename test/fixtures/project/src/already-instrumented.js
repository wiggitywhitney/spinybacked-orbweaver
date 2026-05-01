// ABOUTME: Test fixture — file with existing OpenTelemetry instrumentation.
// ABOUTME: Tests RST-005 (already-instrumented detection and skip).
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('fixture-service');

export async function handleWebhook(req, res) {
  return tracer.startActiveSpan('handleWebhook', async (span) => {
    try {
      const payload = req.body;
      span.setAttribute('webhook.type', payload.type);
      const result = await processWebhookPayload(payload);
      res.json({ status: 'ok', result });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}

function processWebhookPayload(payload) {
  return { processed: true, type: payload.type };
}
