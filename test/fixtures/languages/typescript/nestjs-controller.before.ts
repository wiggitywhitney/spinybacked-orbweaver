// ABOUTME: NestJS-like controller fixture for golden file tests.
// ABOUTME: Demonstrates class decorator pattern with locally-defined stubs (no @nestjs/common dep).

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

@Controller("users")
export class UserController {
  @Get(":id")
  async getUser(
    id: string,
  ): Promise<{ id: string; email: string; name: string }> {
    const user = await findUserById(id);
    return user;
  }

  @Post()
  async createUser(dto: CreateUserDto): Promise<{ id: string }> {
    const result = await persistUser(dto);
    return result;
  }
}
