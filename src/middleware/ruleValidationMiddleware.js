'use strict';

const { defaultRuleParser, RuleParserError } = require('../core/ruleParser');

/**
 * NexusFlow Rule Validation Middleware
 * Pre-validates incoming visual graph JSON payloads for syntax, structure,
 * cycle detection, and DAG connectivity before reaching controller handlers.
 */

function validateRulePayload(options = {}) {
  const maxNodes = options.maxNodes || 100;

  return (req, res, next) => {
    const payload = req.body;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({
        error: 'INVALID_PAYLOAD',
        message: 'Request body must be a non-null JSON object containing nodes and edges',
      });
    }

    if (!Array.isArray(payload.nodes)) {
      return res.status(400).json({
        error: 'MISSING_NODES',
        message: 'Rule definition must include a "nodes" array',
      });
    }

    if (payload.nodes.length === 0) {
      return res.status(400).json({
        error: 'EMPTY_GRAPH',
        message: 'Rule graph must contain at least one source and one action node',
      });
    }

    if (payload.nodes.length > maxNodes) {
      return res.status(400).json({
        error: 'EXCEEDS_MAX_NODES',
        message: `Rule graph contains ${payload.nodes.length} nodes, which exceeds maximum limit of ${maxNodes}`,
      });
    }

    // If payload is already a pre-compiled AST, verify required AST fields
    if (payload.pipeline && Array.isArray(payload.executionPlan) && payload.isValid) {
      req.compiledAst = payload;
      return next();
    }

    // Otherwise, parse and validate graph through RuleParser
    try {
      const compiledAst = defaultRuleParser.parse(payload);
      req.compiledAst = compiledAst;
      return next();
    } catch (err) {
      if (err instanceof RuleParserError) {
        return res.status(400).json({
          error: err.code,
          message: err.message,
          details: err.details,
        });
      }
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: err.message,
      });
    }
  };
}

module.exports = {
  validateRulePayload,
};
