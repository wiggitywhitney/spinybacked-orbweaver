// ABOUTME: NestJS-like controller fixture for golden file tests.
// ABOUTME: Demonstrates class decorator pattern with locally-defined stubs (no @nestjs/common dep).

import { trace, SpanStatusCode } from "@opentelemetry/api";

// Minimal decorator stubs — enable decorator syntax without @nestjs/common dependency.
// Return `any` so TypeScript accepts them as valid class/method decorators.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Controller(_prefix: string): any {
  return (): void => {};
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Get(_path?: string): any {
  return (): void => {};
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Post(): any {
  return (): void => {};
}

interface CreateUserDto {
  email: string;
  name: string;
}

async function findUserById(
  id: string,
): Promise<{ id: string; email: string; name: string }> {
  return { id, email: "user@example.com", name: "Test User" };
}

async function persistUser(dto: CreateUserDto): Promise<{ id: string }> {
  void dto;
  return { id: "user-1" };
}

const tracer = trace.getTracer("user-controller");

@Controller("users")
export class UserController {
  @Get(":id")
  async getUser(
    id: string,
  ): Promise<{ id: string; email: string; name: string }> {
    return tracer.startActiveSpan("GET /users/:id", async (span) => {
      try {
        span.setAttribute("user.id", id);
        const user = await findUserById(id);
        return user;
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

  @Post()
  async createUser(dto: CreateUserDto): Promise<{ id: string }> {
    return tracer.startActiveSpan("POST /users", async (span) => {
      try {
        span.setAttribute("user.email", dto.email);
        const result = await persistUser(dto);
        span.setAttribute("user.id", result.id);
        return result;
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
}
