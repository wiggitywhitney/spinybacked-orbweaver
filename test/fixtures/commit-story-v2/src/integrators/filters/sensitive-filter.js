// ABOUTME: Test fixture — pure sync sensitive data filter (regex redaction); correct outcome is 0 spans (all sync transforms).
// ABOUTME: Run-5 PARTIAL (0 spans): redactSensitiveData failed with persistent NDS-003 oscillation; run-4: 0 spans (same, correct outcome).
/**
 * Sensitive Data Filter - Redacts API keys, tokens, and secrets
 *
 * Uses regex patterns to detect and redact sensitive data.
 * Replaces matches with [REDACTED] to preserve context structure.
 */

/**
 * Sensitive data patterns to detect and redact
 * Each pattern has a name for logging/debugging
 */
const SENSITIVE_PATTERNS = [
  // API Keys (generic patterns)
  {
    pattern: /(?:api[_-]?key|apikey|api_secret)['":\s=]*['""]?([a-zA-Z0-9_-]{20,})['""]?/gi,
    name: 'API Key',
  },

  // AWS Access Keys (start with AKIA)
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    name: 'AWS Access Key',
  },

  // AWS Secret Keys (40 char base64-like)
  {
    pattern: /(?:aws_secret|secret_access_key)['":\s=]*['""]?([A-Za-z0-9/+=]{40})['""]?/gi,
    name: 'AWS Secret Key',
  },

  // JWT Tokens (three base64 segments separated by dots)
  {
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    name: 'JWT Token',
  },

  // Generic Secrets (password, secret, token, credential patterns)
  {
    pattern: /(?:password|passwd|secret|token|credential)['":\s=]*['""]?([^\s'"]{8,64})['""]?/gi,
    name: 'Generic Secret',
  },

  // Private Keys (PEM format)
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
    name: 'Private Key',
  },

  // GitHub Tokens (various formats)
  {
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    name: 'GitHub Token',
  },

  // GitHub Personal Access Tokens (classic format)
  {
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
    name: 'GitHub PAT',
  },

  // Anthropic API Keys (sk-ant- followed by various lengths)
  {
    pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
    name: 'Anthropic API Key',
  },

  // OpenAI API Keys
  {
    pattern: /sk-[a-zA-Z0-9]{48,}/g,
    name: 'OpenAI API Key',
  },

  // Datadog API Keys
  {
    pattern: /dd[a-z]*_[a-zA-Z0-9]{32,}/g,
    name: 'Datadog API Key',
  },

  // Slack Tokens
  {
    pattern: /xox[baprs]-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,
    name: 'Slack Token',
  },

  // Bearer Tokens (in Authorization headers)
  {
    pattern: /(?:Bearer|bearer)\s+[a-zA-Z0-9_-]{20,}/g,
    name: 'Bearer Token',
  },
];

/**
 * Optional email pattern (disabled by default)
 * Enable via options.redactEmails = true
 */
const EMAIL_PATTERN = {
  pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  name: 'Email Address',
};

/**
 * Redact sensitive data from text
 * @param {string} text - Text to redact
 * @param {object} options - Redaction options
 * @returns {object} Redacted text and stats
 */
export function redactSensitiveData(text, options = {}) {
  if (!text) {
    return { text: '', redactions: [], redactionCount: 0 };
  }

  const { redactEmails = false, placeholder = '[REDACTED]' } = options;

  let redactedText = text;
  const redactions = [];

  // Apply all sensitive patterns
  const patterns = [...SENSITIVE_PATTERNS];
  if (redactEmails) {
    patterns.push(EMAIL_PATTERN);
  }

  for (const { pattern, name } of patterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    const matches = redactedText.match(pattern);
    if (matches) {
      for (const match of matches) {
        redactions.push({
          type: name,
          length: match.length,
          // Don't log actual value, just metadata
        });
      }
      redactedText = redactedText.replace(pattern, placeholder);
    }
  }

  return {
    text: redactedText,
    redactions,
    redactionCount: redactions.length,
  };
}

/**
 * Redact sensitive data from a commit diff
 * @param {string} diff - Git diff content
 * @param {object} options - Redaction options
 * @returns {object} Redacted diff and stats
 */
export function redactDiff(diff, options = {}) {
  return redactSensitiveData(diff, options);
}

/**
 * Redact sensitive data from chat messages
 * @param {object[]} messages - Filtered chat messages
 * @param {object} options - Redaction options
 * @returns {object} Messages with redacted content and stats
 */
export function redactMessages(messages, options = {}) {
  if (!messages || messages.length === 0) {
    return { messages: [], totalRedactions: 0, redactionsByType: {} };
  }

  const redactedMessages = [];
  const redactionsByType = {};
  let totalRedactions = 0;

  for (const message of messages) {
    const { text, redactions } = redactSensitiveData(message.content, options);

    redactedMessages.push({
      ...message,
      content: text,
    });

    // Track redaction stats
    totalRedactions += redactions.length;
    for (const r of redactions) {
      redactionsByType[r.type] = (redactionsByType[r.type] || 0) + 1;
    }
  }

  return {
    messages: redactedMessages,
    totalRedactions,
    redactionsByType,
  };
}

/**
 * Apply sensitive data filtering to full context
 * @param {object} context - Full context object
 * @param {object} options - Redaction options
 * @returns {object} Context with sensitive data redacted
 */
export function applySensitiveFilter(context, options = {}) {
  const result = { ...context };

  // Redact diff
  const diffResult = redactDiff(context.commit.diff, options);
  result.commit = {
    ...context.commit,
    diff: diffResult.text,
  };

  // Redact commit message (less common but possible)
  const messageResult = redactSensitiveData(context.commit.message, options);
  result.commit.message = messageResult.text;

  // Redact chat messages
  const chatResult = redactMessages(context.chat.messages, options);
  result.chat = {
    ...context.chat,
    messages: chatResult.messages,
  };

  // Update metadata with redaction stats
  result.metadata = {
    ...context.metadata,
    sensitiveDataFilter: {
      diffRedactions: diffResult.redactionCount,
      messageRedactions: messageResult.redactionCount,
      chatRedactions: chatResult.totalRedactions,
      totalRedactions:
        diffResult.redactionCount + messageResult.redactionCount + chatResult.totalRedactions,
      redactionsByType: chatResult.redactionsByType,
    },
  };

  return result;
}
