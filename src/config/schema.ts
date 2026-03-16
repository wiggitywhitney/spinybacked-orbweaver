// ABOUTME: Zod schema for orbweaver.yaml agent configuration.
// ABOUTME: Defines AgentConfigSchema with defaults, enum constraints, and strict unknown-field rejection.

import { z } from 'zod';

/**
 * Agent effort level — controls thinking depth via the effort API parameter.
 * low: fast, minimal thinking. medium: balanced (default). high: thorough, higher latency.
 */
const AgentEffort = z.enum(['low', 'medium', 'high']);

/**
 * Dependency installation strategy — set during `orbweaver init` based on project type.
 * dependencies: for services (backend APIs, workers). peerDependencies: for distributable packages.
 */
const DependencyStrategy = z.enum(['dependencies', 'peerDependencies']);

/**
 * PR annotation strictness level.
 * strict: flag tier 3+. moderate: outliers only. off: no warnings.
 */
const ReviewSensitivity = z.enum(['strict', 'moderate', 'off']);

/**
 * Zod schema for orbweaver.yaml — the single source of truth for config shape.
 * All optional fields have defaults so the parsed output is fully populated.
 *
 * The schema uses z.strictObject to reject unknown fields (typo detection
 * is handled separately in the loader).
 */
export const AgentConfigSchema = z.strictObject({
  // Required
  schemaPath: z.string().min(1),
  sdkInitFile: z.string().min(1),

  // Agent API configuration
  agentModel: z.string().default('claude-sonnet-4-6'),
  agentEffort: AgentEffort.default('medium'),

  // Agent behavior
  autoApproveLibraries: z.boolean().default(true),
  testCommand: z.string().default('npm test'),

  // Dependency strategy
  dependencyStrategy: DependencyStrategy.default('dependencies'),

  // Limits and guardrails
  maxFilesPerRun: z.number().int().positive().default(50),
  maxFixAttempts: z.number().int().nonnegative().default(2),
  maxTokensPerFile: z.number().int().positive().default(100000),
  largeFileThresholdLines: z.number().int().positive().default(500),
  schemaCheckpointInterval: z.number().int().positive().default(5),
  checkpointLocThreshold: z.number().int().positive().optional(),
  attributesPerFileThreshold: z.number().int().positive().default(30),
  spansPerFileThreshold: z.number().int().positive().default(20),
  weaverMinVersion: z.string().default('0.21.2'),

  // Review
  reviewSensitivity: ReviewSensitivity.default('moderate'),

  // Execution mode
  dryRun: z.boolean().default(false),
  confirmEstimate: z.boolean().default(true),

  // File filtering
  exclude: z.array(z.string()).default([]),

  // Reserved for post-PoC (recognized but unused)
  instrumentationMode: z.string().optional(),
});

/** Validated agent configuration — all optional fields resolved to defaults. */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
