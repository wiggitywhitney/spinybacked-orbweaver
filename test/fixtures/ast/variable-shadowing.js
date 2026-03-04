// ABOUTME: Test fixture — JavaScript file with variables that shadow OTel naming conventions
import { fetchData } from './utils.js';

export function processWithSpan(items) {
  // 'span' is used as a local variable — would shadow OTel span
  const span = items.length;
  return items.slice(0, span);
}

export async function handleWithTracer(req, res) {
  // 'tracer' is used as a local variable — would shadow OTel tracer
  const tracer = new RequestTracer(req);
  const result = await tracer.trace(() => fetchData(req.url));
  res.json(result);
}

class RequestTracer {
  constructor(req) {
    this.req = req;
  }
  async trace(fn) {
    return fn();
  }
}

export function noShadowing(data) {
  const result = data.map(d => d.value);
  return result;
}

export function nestedShadowing(items) {
  // 'span' used in a nested block scope
  for (const item of items) {
    const span = item.duration;
    if (span > 100) {
      console.log('slow item', item.name);
    }
  }
  return items;
}
