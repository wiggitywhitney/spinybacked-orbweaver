// ABOUTME: Test fixture — JavaScript file with existing OpenTelemetry imports and instrumentation
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('handleRequest', async (span) => {
    try {
      const result = await processData(req.body);
      span.setAttribute('result.count', result.length);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}

async function processData(data) {
  return data.items.map(item => item.value);
}
