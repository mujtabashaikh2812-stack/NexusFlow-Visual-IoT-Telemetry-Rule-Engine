'use strict';

/**
 * RuleDefinition: the saved form of a visual rule built in React Flow.
 *
 *  - ruleId   : stable business key for the rule (unique; URL-safe characters)
 *  - name     : human label shown in the rule list
 *  - nodes    : React Flow nodes { id, type, position: { x, y }, data }
 *  - edges    : React Flow edges { id, source, target, sourceHandle?, targetHandle?, label?, data? }
 *  - version  : starts at 1 and goes up each time the graph is saved
 *  - isActive : whether the engine should evaluate this rule
 *
 * Checks made before anything is stored:
 *  - at least one node, and node ids are unique
 *  - every edge points at a node that exists in the same graph
 *
 * Loading this file never touches the network. The collection and its unique
 * ruleId index are created explicitly, so tests and CI runs work with no
 * database. buildRuleDefinition() returns a validated plain object that can be
 * written to a real collection or to the in-memory fallback store alike.
 */

const mongoose = require('mongoose');

const MODEL_NAME = 'RuleDefinition';
const COLLECTION_NAME = 'rule_definitions';
const RULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_VERSION = 1;

const positionSchema = new mongoose.Schema(
  {
    x: { type: Number, required: true, validate: { validator: Number.isFinite, message: 'x must be a finite number' } },
    y: { type: Number, required: true, validate: { validator: Number.isFinite, message: 'y must be a finite number' } }
  },
  { _id: false }
);

const nodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, minlength: 1, maxlength: 128 },
    type: { type: String, trim: true, default: 'default' },
    position: { type: positionSchema, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { _id: false }
);

const edgeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, minlength: 1, maxlength: 128 },
    source: { type: String, required: true, trim: true },
    target: { type: String, required: true, trim: true },
    sourceHandle: { type: String, trim: true },
    targetHandle: { type: String, trim: true },
    label: { type: String, trim: true },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { _id: false }
);

const ruleDefinitionSchema = new mongoose.Schema(
  {
    ruleId: {
      type: String,
      required: true,
      trim: true,
      match: [RULE_ID_PATTERN, 'ruleId may use letters, digits, "_" and "-" only (1 to 64 characters)']
    },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    nodes: {
      type: [nodeSchema],
      required: true,
      validate: [
        { validator: (nodes) => nodes.length >= 1, message: 'a rule needs at least one node' },
        {
          validator: (nodes) => new Set(nodes.map((n) => n.id)).size === nodes.length,
          message: 'node ids must be unique within a rule'
        }
      ]
    },
    edges: {
      type: [edgeSchema],
      default: () => [],
      validate: {
        validator(edges) {
          const ids = new Set((this.nodes || []).map((n) => n.id));
          return edges.every((e) => ids.has(e.source) && ids.has(e.target));
        },
        message: 'every edge must connect two nodes that exist in the rule'
      }
    },
    version: {
      type: Number,
      required: true,
      default: DEFAULT_VERSION,
      validate: { validator: (v) => Number.isInteger(v) && v >= 1, message: 'version must be a whole number of at least 1' }
    },
    isActive: { type: Boolean, required: true, default: false }
  },
  {
    versionKey: false,
    timestamps: true,
    // Collection creation and index builds are explicit, never a side effect of loading the model.
    autoCreate: false,
    autoIndex: false
  }
);

ruleDefinitionSchema.index({ ruleId: 1 }, { unique: true, name: 'ruleId_1' });

/**
 * Returns the RuleDefinition model for a connection (default: the shared
 * mongoose connection). Safe to call repeatedly; the model is compiled once.
 */
function getRuleDefinitionModel(connection) {
  const conn = connection || mongoose;
  return (conn.models && conn.models[MODEL_NAME]) || conn.model(MODEL_NAME, ruleDefinitionSchema, COLLECTION_NAME);
}

/**
 * Validates and normalises one rule graph. Returns a plain object with ruleId,
 * name, nodes, edges, version, isActive (and timestamps once saved) or throws a
 * ValidationError that names the offending fields. No database is needed.
 */
function buildRuleDefinition(input) {
  const Model = getRuleDefinitionModel();
  const doc = new Model(input || {});
  const error = doc.validateSync();
  if (error) throw error;
  const plain = doc.toObject({ versionKey: false, minimize: false }); // keep empty data objects
  delete plain._id; // let the store assign it
  return plain;
}

module.exports = {
  MODEL_NAME,
  COLLECTION_NAME,
  RULE_ID_PATTERN,
  DEFAULT_VERSION,
  ruleDefinitionSchema,
  getRuleDefinitionModel,
  buildRuleDefinition
};
