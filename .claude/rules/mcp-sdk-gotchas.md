# MCP SDK v1.27.x Gotchas

Verified against SDK v1.27.1 type definitions on 2026-03-05. Version pinning guidance updated 2026-03-14.

## Import Paths

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
```

## API

- **`server.tool()` is deprecated** — use `server.registerTool()` with config object.
- **`registerTool` callback signature**: `(args, extra) => CallToolResult | Promise<CallToolResult>`. The `extra` is `RequestHandlerExtra` with `signal`, `sessionId`, `sendNotification`, `sendRequest`.
- **`extra` does NOT have `mcpReq.log()`** — that was a documentation error. For logging from tool handlers, use `mcpServer.sendLoggingMessage()` (captured in closure).
- **CallToolResult requires index signature** — custom return types need `[key: string]: unknown` to satisfy the `Result` base interface.

## Logging

- Declare `capabilities: { logging: {} }` in McpServer constructor's second parameter.
- Call `mcpServer.sendLoggingMessage({ level: "info", data: "message" })` — available directly on `McpServer` (not `.server`).
- Must connect to transport before sending log messages.

## Zod Integration

- `inputSchema` in `registerTool` accepts Zod raw shape (object properties, NOT `z.object()`).
- Pass `{ foo: z.string(), bar: z.number().optional() }` directly, not `z.object({...})`.
- Compatible with Zod v3.25+ and v4.x.

## Version Pinning

- Pin to `^1.27` (matching >=1.27.0 to <2.0.0).
- v2 is nearing stable release as of March 2026. v1 will receive security patches for 6+ months after v2 ships. Evaluate v2 migration when it reaches GA and the MCP server code is next modified.
