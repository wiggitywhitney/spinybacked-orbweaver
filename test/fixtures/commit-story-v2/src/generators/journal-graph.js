// ABOUTME: Test fixture — LangGraph pipeline for journal section generation; 1 exported function and 3 internal node functions.
// ABOUTME: Run-5 PARTIAL (1 span): fallback only covered exported function, skipped 3 internal nodes (summaryNode, technicalNode, dialogueNode); run-4: 4 spans.
/**
 * Journal Graph - LangGraph StateGraph for journal generation
 *
 * Orchestrates AI generation of journal sections:
 * - Summary: Narrative overview of the commit
 * - Dialogue: Key quotes from human/assistant conversation
 * - Technical Decisions: Architecture and implementation decisions
 *
 * Graph structure:
 * START → [summary, technical] (parallel) → dialogue → END
 */

import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getAllGuidelines } from './prompts/guidelines/index.js';
import { summaryPrompt } from './prompts/sections/summary-prompt.js';
import { dialoguePrompt } from './prompts/sections/dialogue-prompt.js';
import { technicalDecisionsPrompt } from './prompts/sections/technical-decisions-prompt.js';

/**
 * Journal state definition using LangGraph Annotation API
 * Errors use a reducer to accumulate from parallel nodes
 */
export const JournalState = Annotation.Root({
  // Input
  context: Annotation(),

  // Outputs (populated by nodes)
  summary: Annotation(),
  dialogue: Annotation(),
  technicalDecisions: Annotation(),

  // Metadata
  errors: Annotation({
    reducer: (left, right) => [...(left || []), ...(right || [])],
    default: () => [],
  }),
});

/**
 * Per-node temperature settings matching v1 behavior:
 * - Summary (narrative): 0.7 for casual, natural tone
 * - Dialogue (quote selection): 0.7 for natural selection
 * - Technical decisions (factual): 0.1 for consistent extraction
 */
const NODE_TEMPERATURES = {
  summary: 0.7,
  dialogue: 0.7,
  technical: 0.1,
};

/**
 * Cache of model instances keyed by temperature
 * Avoids recreating models for the same temperature
 */
const models = new Map();

/**
 * Get or create a Claude model instance for a given temperature
 * @param {number} temperature - Temperature setting for the model
 * @returns {ChatAnthropic} Model instance
 */
export function getModel(temperature = 0) {
  if (!models.has(temperature)) {
    models.set(
      temperature,
      new ChatAnthropic({
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 2048,
        temperature,
      })
    );
  }
  return models.get(temperature);
}

/**
 * Reset all model instances (for testing)
 */
export function resetModel() {
  models.clear();
}

/**
 * Analyze commit diff to categorize changed files
 * Returns lists of documentation files vs functional code files
 * @param {string} diff - Git diff content
 * @returns {object} Analysis result with file categorizations
 */
function analyzeCommitContent(diff) {
  if (!diff) {
    return {
      changedFiles: [],
      docFiles: [],
      functionalFiles: [],
      hasFunctionalCode: false,
      hasOnlyDocs: false,
    };
  }

  // Extract file paths from diff headers (e.g., "+++ b/src/index.js")
  const fileHeaderPattern = /^[+-]{3} [ab]\/(.+)$/gm;
  const matches = [...diff.matchAll(fileHeaderPattern)];
  const allFiles = [...new Set(matches.map((m) => m[1]))];

  // Filter out journal entries (prevent recursive pollution)
  const changedFiles = allFiles.filter((f) => !f.startsWith('journal/entries/'));

  // Documentation file patterns
  const isDocFile = (file) => {
    const docPatterns = [
      /\.md$/i,
      /\.txt$/i,
      /README/i,
      /CHANGELOG/i,
      /LICENSE/i,
      /\.ya?ml$/i,
      /\.json$/i,
      /\.toml$/i,
      /\.ini$/i,
      /\.env/i,
      /\.gitignore$/i,
    ];
    return docPatterns.some((pattern) => pattern.test(file));
  };

  const docFiles = changedFiles.filter(isDocFile);
  const functionalFiles = changedFiles.filter((f) => !isDocFile(f));

  return {
    changedFiles,
    docFiles,
    functionalFiles,
    hasFunctionalCode: functionalFiles.length > 0,
    hasOnlyDocs: docFiles.length > 0 && functionalFiles.length === 0,
  };
}

/**
 * Legacy wrapper for hasFunctionalCode checks
 * @param {string} diff - Git diff content
 * @returns {boolean} Whether the diff contains functional code changes
 */
function hasFunctionalCode(diff) {
  return analyzeCommitContent(diff).hasFunctionalCode;
}

/**
 * Generate dynamic implementation guidance based on diff analysis
 * Tells the AI exactly which files changed and how to classify decisions
 * @param {object} analysis - Result from analyzeCommitContent
 * @returns {string} Implementation guidance to append to prompt
 */
function generateImplementationGuidance(analysis) {
  const { functionalFiles, docFiles, hasOnlyDocs } = analysis;

  if (hasOnlyDocs) {
    return `
IMPLEMENTATION GUIDANCE:
This commit contains ONLY documentation changes: ${docFiles.join(', ')}
- All decisions should be marked as "Discussed" since no functional code was changed
- Focus on the reasoning behind documentation updates`;
  }

  if (functionalFiles.length > 0) {
    return `
IMPLEMENTATION GUIDANCE:
Changed functional files: ${functionalFiles.join(', ')}
${docFiles.length > 0 ? `Changed documentation files: ${docFiles.join(', ')}` : ''}

IMPLEMENTED vs DISCUSSED classification:
- "Implemented" = Decision resulted in changes to: ${functionalFiles.join(', ')}
- "Discussed" = Decision was talked about but no related code changes in this commit

INSTRUCTION: Mark a decision as "Implemented" ONLY if it directly relates to changes in: ${functionalFiles.join(', ')}`;
  }

  return '';
}

/**
 * Format chat sessions for AI consumption with session grouping
 * Restores v1's session-grouped format to prevent cross-context dialogue bleed
 * @param {Map} sessions - Map of sessionId to message arrays from context.chat.sessions
 * @returns {Array} Formatted session objects for JSON serialization
 */
function formatSessionsForAI(sessions) {
  if (!sessions || sessions.size === 0) {
    return [];
  }

  let index = 0;
  const result = [];
  for (const [, messages] of sessions) {
    index++;
    const firstMsg = messages[0];
    result.push({
      session_id: `Session ${index}`,
      session_start: firstMsg?.timestamp || null,
      message_count: messages.length,
      messages: messages.map((msg) => ({
        type: msg.type,
        content: msg.content,
        timestamp: msg.timestamp,
      })),
    });
  }
  return result;
}

/**
 * Format chat messages as flat list (legacy, used for formatChatMessages compatibility)
 * @param {object[]} messages - Filtered chat messages
 * @returns {string} Formatted messages in JSON-line format
 */
function formatChatMessages(messages) {
  if (!messages || messages.length === 0) {
    return '*No conversation captured for this time window*';
  }

  return messages
    .map((msg) => {
      const type = msg.type === 'user' ? 'user' : 'assistant';
      const date = msg.timestamp ? new Date(msg.timestamp) : null;
      const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString() : '';
      return `{"type":"${type}", "time":"${time}", "content":"${escapeForJson(msg.content)}"}`;
    })
    .join('\n\n');
}

/**
 * Escape content for JSON string inclusion
 * @param {string} content - Content to escape
 * @returns {string} Escaped content
 */
function escapeForJson(content) {
  if (!content) return '';
  return content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Format context for summary generation (filters out assistant messages)
 * Uses session-grouped format with self-documenting descriptions
 */
function formatContextForSummary(context) {
  // Build session-grouped user-only messages
  const sessions = context.chat?.sessions;
  const userOnlySessions = [];

  if (sessions && sessions.size > 0) {
    let index = 0;
    for (const [, messages] of sessions) {
      const userMsgs = messages.filter((m) => m.type === 'user');
      if (userMsgs.length > 0) {
        index++;
        userOnlySessions.push({
          session_id: `Session ${index}`,
          message_count: userMsgs.length,
          messages: userMsgs.map((m) => ({ type: m.type, content: m.content })),
        });
      }
    }
  }

  return `Generate a summary for this development session:

AVAILABLE DATA:
- Git commit data including hash, author, timestamp, message, and diff
- Chat sessions grouped by session ID with developer messages only (assistant responses filtered out)
  Focus on what THE DEVELOPER did, not what the AI said

COMMIT DATA:
${JSON.stringify(
  {
    hash: context.commit.shortHash,
    author: context.commit.author,
    message: context.commit.message,
    diff: context.commit.diff || 'No diff available',
  },
  null,
  2
)}

DEVELOPER MESSAGES (grouped by session, type:"user" only):
${JSON.stringify(userOnlySessions, null, 2)}`;
}

/**
 * Format context for dialogue/technical extraction (needs full chat)
 * Uses session-grouped format with self-documenting descriptions
 */
function formatContextForUser(context, options = {}) {
  const { includeSummary } = options;

  // Format sessions for AI consumption
  const sessions = formatSessionsForAI(context.chat?.sessions);

  let userContent = `## Commit Information
**Hash**: ${context.commit.shortHash}
**Author**: ${context.commit.author}
**Message**: ${context.commit.message}

## Code Changes
\`\`\`diff
${context.commit.diff || 'No diff available'}
\`\`\`

## Development Conversation
AVAILABLE DATA: Chat sessions grouped by session ID with message counts
- type:"user" = developer input (human quotes come from here)
- type:"assistant" = AI responses (use only for context)

${JSON.stringify(sessions, null, 2)}`;

  if (includeSummary) {
    userContent = `## Session Summary
${options.summary}

${userContent}`;
  }

  return userContent;
}

/**
 * Post-processing: strip preamble and commentary from dialogue output
 * Keeps only lines starting with > (blockquotes) and blank lines between them
 * Falls back to original if no quotes found
 */
function cleanDialogueOutput(raw) {
  if (!raw || raw.includes('No significant dialogue')) return raw;

  const lines = raw.split('\n');
  const cleaned = [];
  let inQuoteBlock = false;

  for (const line of lines) {
    if (line.startsWith('> ')) {
      inQuoteBlock = true;
      cleaned.push(line);
    } else if (inQuoteBlock && line.trim() === '') {
      // Blank line between quote blocks
      cleaned.push('');
      inQuoteBlock = false;
    } else if (inQuoteBlock) {
      // Continuation of a blockquote that doesn't start with >
      // (shouldn't happen with our format, skip it)
      inQuoteBlock = false;
    }
    // Skip all other lines (preamble, commentary)
  }

  const result = cleaned.join('\n').trim();
  if (!result) return 'No significant dialogue found for this development session';
  // Fix literal \n from JSON-escaped content that the model copied verbatim
  return result.replace(/\\n/g, '\n');
}

/**
 * Post-processing: strip preamble from technical decisions output
 * Keeps only lines starting with **DECISION: and their sub-items
 */
function cleanTechnicalOutput(raw) {
  if (!raw || raw.includes('No significant technical decisions')) return raw;

  const lines = raw.split('\n');
  const cleaned = [];
  let inDecision = false;

  for (const line of lines) {
    if (line.startsWith('**DECISION:') || line.startsWith('- **DECISION:')) {
      inDecision = true;
      cleaned.push(line);
    } else if (inDecision && (line.match(/^\s+-/) || line.match(/^\s+Tradeoffs:/))) {
      // Sub-items of a decision (with any indentation)
      cleaned.push(line);
    } else if (inDecision && line.trim() === '') {
      // Blank line between decisions
      cleaned.push('');
      inDecision = false;
    } else {
      inDecision = false;
    }
  }

  const result = cleaned.join('\n').trim();
  // If no DECISION lines found, return default message instead of raw narrative
  return result || 'No significant technical decisions documented for this development session';
}

/**
 * Post-processing: replace banned formal words in summary output
 * These words persist despite prompt instructions, so we handle them deterministically
 */
const BANNED_WORD_REPLACEMENTS = [
  [/\bcomprehensiv(e|ely)\b/gi, (_, suffix) => suffix === 'ely' ? 'thoroughly' : 'detailed'],
  [/\brobust\b/gi, 'solid'],
  [/\bsignificant\b/gi, 'important'],
  [/\bsystematic(ally)?\b/gi, (_, suffix) => suffix ? 'carefully' : 'structured'],
  [/\bmeticulous(ly)?\b/gi, (_, suffix) => suffix ? 'carefully' : 'careful'],
  [/\bmethodical(ly)?\b/gi, (_, suffix) => suffix ? 'carefully' : 'careful'],
  [/\ba sophisticated\b/gi, 'an advanced'],
  [/\bsophisticated\b/gi, 'advanced'],
  [/\bleverag(e[ds]?|ing)\b/gi, (_, suffix) => suffix === 'ing' ? 'using' : 'used'],
  [/\benhance[ds]?\b/gi, 'improved'],
  [/\benhancing\b/gi, 'improving'],
  [/\benhancements?\b/gi, (match) => match.endsWith('s') ? 'improvements' : 'improvement'],
  [/\butiliz(e[ds]?|ing|ation)\b/gi, (_, suffix) => {
    if (suffix === 'ing') return 'using';
    if (suffix === 'ation') return 'use';
    return 'used';
  }],
];

function cleanSummaryOutput(raw) {
  if (!raw) return raw;
  let result = raw;
  for (const [pattern, replacement] of BANNED_WORD_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  // Strip preamble lines like "Based on the git commit..." or "Here's a summary..."
  result = result.replace(/^(Based on|Here's|Here is|Looking at|Let me)[^\n]*\n*/i, '');
  return result.trim();
}

/**
 * Summary generation node
 * Creates a narrative overview of the commit
 */
async function summaryNode(state) {
  try {
    const { context } = state;
    const guidelines = getAllGuidelines();
    const hasFunctional = hasFunctionalCode(context.commit.diff);
    // Use pre-computed stats from message filter instead of re-iterating
    const hasChat = (context.metadata?.filterStats?.substantialUserMessages ?? 0) >= 2;
    const sectionPrompt = summaryPrompt(hasFunctional, hasChat);

    const systemContent = `${guidelines}

${sectionPrompt}`;

    const userContent = formatContextForSummary(context);

    const result = await getModel(NODE_TEMPERATURES.summary).invoke([
      new SystemMessage(systemContent),
      new HumanMessage(userContent),
    ]);

    return { summary: cleanSummaryOutput(result.content) };
  } catch (error) {
    return {
      summary: '[Summary generation failed]',
      errors: [`Summary generation failed: ${error.message}`],
    };
  }
}

/**
 * Technical decisions extraction node
 * Identifies architecture and implementation decisions
 * Returns free-form markdown (v1 approach - prompts enforce format)
 * Early exit when no substantial user messages exist
 */
async function technicalNode(state) {
  try {
    const { context } = state;

    // Early exit: skip AI call when no substantial user messages (v1 pattern)
    const substantialUserMessages = context.metadata?.filterStats?.substantialUserMessages ?? 0;
    if (substantialUserMessages === 0) {
      return { technicalDecisions: 'No significant technical decisions documented for this development session' };
    }

    const guidelines = getAllGuidelines();

    // Analyze diff to generate dynamic implementation guidance
    const diffAnalysis = analyzeCommitContent(context.commit.diff);
    const implementationGuidance = generateImplementationGuidance(diffAnalysis);

    const systemContent = `${guidelines}

${technicalDecisionsPrompt}
${implementationGuidance}`;

    const userContent = formatContextForUser(context);

    const result = await getModel(NODE_TEMPERATURES.technical).invoke([
      new SystemMessage(systemContent),
      new HumanMessage(userContent),
    ]);

    return { technicalDecisions: cleanTechnicalOutput(result.content.trim()) };
  } catch (error) {
    return {
      technicalDecisions: '[Technical decisions extraction failed]',
      errors: [`Technical decisions extraction failed: ${error.message}`],
    };
  }
}

/**
 * Dialogue extraction node
 * Extracts key quotes from human/assistant conversation
 * Runs after summary to avoid redundancy
 * Returns free-form markdown (v1 approach - prompts enforce format)
 * Early exit when no substantial user messages; dynamic maxQuotes
 */
async function dialogueNode(state) {
  try {
    const { context, summary } = state;

    // Early exit: skip AI call when no substantial user messages (v1 pattern)
    const substantialUserMessages = context.metadata?.filterStats?.substantialUserMessages ?? 0;
    if (substantialUserMessages === 0) {
      return { dialogue: 'No significant dialogue found for this development session' };
    }

    const guidelines = getAllGuidelines();

    // Dynamic maxQuotes: 8% of substantial user messages + 1 (v1 formula)
    const maxQuotes = Math.min(Math.ceil(substantialUserMessages * 0.08) + 1, 15);

    // Replace {maxQuotes} placeholder in prompt
    const sectionPrompt = dialoguePrompt.replace(/{maxQuotes}/g, String(maxQuotes));

    const systemContent = `${guidelines}

The summary of this development session is:
${summary}

${sectionPrompt}`;

    const userContent = formatContextForUser(context, { includeSummary: false });

    const result = await getModel(NODE_TEMPERATURES.dialogue).invoke([
      new SystemMessage(systemContent),
      new HumanMessage(userContent),
    ]);

    return { dialogue: cleanDialogueOutput(result.content.trim()) };
  } catch (error) {
    return {
      dialogue: '[Dialogue extraction failed]',
      errors: [`Dialogue extraction failed: ${error.message}`],
    };
  }
}

/**
 * Build and compile the journal generation graph
 * @returns {CompiledStateGraph} Compiled graph ready for execution
 */
function buildGraph() {
  // Node names use "generate_" prefix to avoid conflict with state attribute names
  const graph = new StateGraph(JournalState)
    .addNode('generate_summary', summaryNode)
    .addNode('generate_technical', technicalNode)
    .addNode('generate_dialogue', dialogueNode)
    // Parallel execution: summary and technical run simultaneously
    .addEdge(START, 'generate_summary')
    .addEdge(START, 'generate_technical')
    // Dialogue waits for both summary and technical to complete
    .addEdge('generate_summary', 'generate_dialogue')
    .addEdge('generate_technical', 'generate_dialogue')
    // End after dialogue
    .addEdge('generate_dialogue', END);

  return graph.compile();
}

// Compiled graph instance
let compiledGraph;

/**
 * Get or create the compiled graph
 * @returns {CompiledStateGraph} Compiled graph
 */
function getGraph() {
  if (!compiledGraph) {
    compiledGraph = buildGraph();
  }
  return compiledGraph;
}

/**
 * Generate all journal sections from context
 * @param {Context} context - Gathered context from integrator
 * @returns {Promise<JournalSections>} Generated journal sections
 */
export async function generateJournalSections(context) {
  const graph = getGraph();

  const result = await graph.invoke({ context });

  return {
    summary: result.summary || '',
    dialogue: result.dialogue || '',
    technicalDecisions: result.technicalDecisions || '',
    errors: result.errors || [],
    generatedAt: new Date(),
  };
}

// Export node functions and helpers for testing
export {
  summaryNode,
  technicalNode,
  dialogueNode,
  formatSessionsForAI,
  formatChatMessages,
  formatContextForUser,
  formatContextForSummary,
  buildGraph,
  hasFunctionalCode,
  analyzeCommitContent,
  generateImplementationGuidance,
  cleanDialogueOutput,
  cleanTechnicalOutput,
  cleanSummaryOutput,
  escapeForJson,
  NODE_TEMPERATURES,
};
