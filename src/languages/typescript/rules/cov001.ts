// ABOUTME: COV-001 TypeScript Tier 2 check — entry points have spans.
// ABOUTME: Extends JS entry point detection with NestJS @Controller class/method decorator support.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Patterns matching entry point registrations (framework route handlers,
 * server callbacks, etc.).
 */
const ENTRY_POINT_PATTERNS: Array<{
  pattern: RegExp;
  framework: string;
}> = [
  // Express route handlers
  { pattern: /^(app|router)\.(get|post|put|patch|delete|use|all|options|head)$/, framework: 'Express' },

  // Fastify route handlers
  { pattern: /^(fastify|server|app)\.(get|post|put|patch|delete|all|head|options|route)$/, framework: 'Fastify' },

  // http.createServer
  { pattern: /^https?\.createServer$/, framework: 'http' },
];

/**
 * NestJS HTTP method decorator names that mark a class method as a route handler.
 */
const NESTJS_METHOD_DECORATORS = new Set([
  'Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All',
  // Also handle lower-case variants in case of non-standard usage
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all',
]);

/**
 * NestJS class-level controller decorators that mark a class as a NestJS controller.
 */
const NESTJS_CLASS_DECORATORS = new Set([
  'Controller', 'Resolver',
]);

/**
 * Parameter names that signal a function is a request/event handler entry point.
 */
const ENTRY_POINT_PARAM_NAMES = new Set([
  'req', 'res', 'request', 'response',
  'ctx', 'context',
  'event',
]);

/**
 * Directory names that indicate a file is a service module (entry point container).
 */
const SERVICE_MODULE_DIRS = /(?:^|[\\/])(routes|handlers|controllers|api|services|middleware|resolvers|mutations|queries|endpoints|jobs|workers|subscribers|commands)(?:[\\/])/;

/**
 * COV-001 TypeScript: Verify that entry points have spans.
 *
 * Detects:
 * - Express route handlers (app.get, app.post, router.get, etc.)
 * - Fastify handlers (fastify.get, etc.)
 * - http.createServer callbacks
 * - Exported async service functions
 * - NestJS @Controller classes with @Get/@Post/@Put/etc. decorated methods
 *
 * @param code - The instrumented TypeScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkEntryPointSpansTs(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      experimentalDecorators: true,
    },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.tsx', code);

  const unspanned: Array<{ line: number; description: string }> = [];

  // Check framework route handlers and createServer callbacks
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const fullText = expr.getText();

    for (const ep of ENTRY_POINT_PATTERNS) {
      if (ep.pattern.test(fullText)) {
        if (!callbackHasSpan(node)) {
          unspanned.push({
            line: node.getStartLineNumber(),
            description: `${ep.framework} handler: ${fullText}()`,
          });
        }
        break;
      }
    }
  });

  // Check NestJS controller class methods with route decorators
  checkNestJsControllerMethods(sourceFile, unspanned);

  // Check exported async service functions
  checkExportedAsyncFunctions(sourceFile, unspanned, filePath);

  if (unspanned.length === 0) {
    return [{
      ruleId: 'COV-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All entry points have spans.',
      tier: 2,
      blocking: true,
    }];
  }

  return unspanned.map((u) => ({
    ruleId: 'COV-001' as const,
    passed: false as const,
    filePath,
    lineNumber: u.line,
    message:
      `COV-001 check failed: ${u.description} at line ${u.line}. ` +
      `Entry points (route handlers, server callbacks, NestJS controller methods, exported service functions) ` +
      `must have spans for request tracing and error visibility.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/**
 * Check if source text contains a span creation call.
 */
function hasSpanStartCall(text: string): boolean {
  return text.includes('.startActiveSpan') || text.includes('.startSpan');
}

/**
 * Check if any callback argument of a call expression contains a span creation call.
 */
function callbackHasSpan(callExpr: CallExpression): boolean {
  const args = callExpr.getArguments();
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      if (hasSpanStartCall(arg.getText())) {
        return true;
      }
    } else if (Node.isIdentifier(arg)) {
      const symbol = arg.getSymbol();
      if (!symbol) continue;
      for (const decl of symbol.getDeclarations()) {
        let bodyText: string | null = null;
        if (Node.isFunctionDeclaration(decl)) {
          bodyText = decl.getText();
        } else if (Node.isVariableDeclaration(decl)) {
          const init = decl.getInitializer();
          if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            bodyText = init.getText();
          }
        }
        if (bodyText && hasSpanStartCall(bodyText)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check NestJS controller classes for route-decorated methods without spans.
 *
 * Detects classes with a @Controller (or @Resolver) class decorator and
 * looks for methods on those classes that have HTTP method decorators
 * (@Get, @Post, @Put, @Patch, @Delete, @Options, @Head, @All) but no span.
 */
function checkNestJsControllerMethods(
  sourceFile: import('ts-morph').SourceFile,
  unspanned: Array<{ line: number; description: string }>,
): void {
  for (const cls of sourceFile.getClasses()) {
    // Check if the class has a NestJS controller decorator
    const hasControllerDecorator = cls.getDecorators().some((dec) => {
      const name = dec.getName();
      return NESTJS_CLASS_DECORATORS.has(name);
    });

    if (!hasControllerDecorator) continue;

    // Class is a NestJS controller — check each method for route decorators
    for (const method of cls.getMethods()) {
      const routeDecorators = method.getDecorators().filter((dec) => {
        return NESTJS_METHOD_DECORATORS.has(dec.getName());
      });

      if (routeDecorators.length === 0) continue;

      // Method has a route decorator — check if it has a span
      const methodText = method.getText();
      if (!hasSpanStartCall(methodText)) {
        const decoratorNames = routeDecorators.map((d) => `@${d.getName()}`).join(', ');
        unspanned.push({
          line: method.getStartLineNumber(),
          description: `NestJS controller method: ${cls.getName() ?? '<anonymous>'}.${method.getName()} (${decoratorNames})`,
        });
      }
    }
  }
}

/**
 * Determine whether an exported async function looks like a service entry point.
 */
function isServiceEntryPoint(paramNames: string[], filePath: string): boolean {
  if (paramNames.some((p) => ENTRY_POINT_PARAM_NAMES.has(p))) {
    return true;
  }
  return SERVICE_MODULE_DIRS.test(filePath);
}

/**
 * Check exported async functions for missing spans.
 */
function checkExportedAsyncFunctions(
  sourceFile: import('ts-morph').SourceFile,
  unspanned: Array<{ line: number; description: string }>,
  filePath: string,
): void {
  // ESM-style function declarations: export async function foo() {}
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isExported() && fn.isAsync()) {
      const name = fn.getName() ?? '<anonymous>';
      const paramNames = fn.getParameters().map((p) => p.getName());
      if (!isServiceEntryPoint(paramNames, filePath)) continue;

      const bodyText = fn.getText();
      if (!hasSpanStartCall(bodyText)) {
        unspanned.push({
          line: fn.getStartLineNumber(),
          description: `exported async function: ${name}`,
        });
      }
    }
  }

  // ESM-style exported arrow/function expression assignments: export const foo = async () => {}
  for (const varStatement of sourceFile.getVariableStatements()) {
    if (!varStatement.isExported()) continue;
    for (const decl of varStatement.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      if ((Node.isArrowFunction(init) || Node.isFunctionExpression(init)) && init.isAsync()) {
        const name = decl.getName();
        const paramNames = init.getParameters().map((p) => p.getName());
        if (!isServiceEntryPoint(paramNames, filePath)) continue;

        const bodyText = init.getText();
        if (!hasSpanStartCall(bodyText)) {
          unspanned.push({
            line: varStatement.getStartLineNumber(),
            description: `exported async function: ${name}`,
          });
        }
      }
    }
  }
}

/** COV-001 TypeScript ValidationRule — entry points must have spans. */
export const cov001TsRule: ValidationRule = {
  ruleId: 'COV-001',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkEntryPointSpansTs(input.instrumentedCode, input.filePath);
  },
};
