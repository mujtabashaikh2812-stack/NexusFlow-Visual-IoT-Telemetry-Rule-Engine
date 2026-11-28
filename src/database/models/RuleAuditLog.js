'use strict';

/**
 * RuleAuditLog: one entry per rule trigger, written when a rule fires on a device.
 *
 *  - ruleId           : the rule that fired (matches RuleDefinition.ruleId)
 *  - deviceId         : the device whose reading caused the trigger (matches Device.deviceId)
 *  - triggerValue     : the reading that was checked against the threshold
 *  - threshold        : the limit the rule compares the reading with
 *  - actionDispatched : the action sent for this trigger, e.g. "sms" or "webhook" (null when nothing was sent)
 *  - latencyMs        : milliseconds from the reading arriving to the action being dispatched (0 or more)
 *  - timestamp        : when the rule fired (defaults to now)
 *
 * Loading this file never touches the network. The collection is created
 * explicitly, so tests and CI runs work with no database. buildRuleAuditLog()
 * returns a validated plain object that can be written to a real collection or
 * to the in-memory fallback store alike.
 */

const mongoose = require('mongoose');
const { RULE_ID_PATTERN } = require('./RuleDefinition');
const { DEVICE_ID_PATTERN } = require('./Device');

const MODEL_NAME = 'RuleAuditLog';
const COLLECTION_NAME = 'rule_audit_logs';
const ACTION_MAX_LENGTH = 64;

const ruleAuditLogSchema = new mongoose.Schema(
  {
    ruleId: {
      type: String,
      required: true,
      trim: true,
      match: [RULE_ID_PATTERN, 'ruleId may use letters, digits, "_" and "-" only (1 to 64 characters)']
    },
    deviceId: {
      type: String,
      required: true,
      trim: true,
      match: [DEVICE_ID_PATTERN, 'deviceId may use letters, digits, "_" and "-" only (1 to 64 characters)']
    },
    triggerValue: {
      type: Number,
      required: true,
      validate: { validator: Number.isFinite, message: 'triggerValue must be a finite number' }
    },
    threshold: {
      type: Number,
      required: true,
      validate: { validator: Number.isFinite, message: 'threshold must be a finite number' }
    },
    actionDispatched: {
      type: String,
      trim: true,
      minlength: 1,
      maxlength: ACTION_MAX_LENGTH,
      default: null
    },
    latencyMs: {
      type: Number,
      required: true,
      validate: { validator: (v) => Number.isFinite(v) && v >= 0, message: 'latencyMs must be a number of at least 0' }
    },
    timestamp: { type: Date, required: true, default: Date.now }
  },
  {
    versionKey: false,
    // Collection creation is explicit, never a side effect of loading the model.
    autoCreate: false,
    autoIndex: false
  }
);

/**
 * Returns the RuleAuditLog model for a connection (default: the shared
 * mongoose connection). Safe to call repeatedly; the model is compiled once.
 */
function getRuleAuditLogModel(connection) {
  const conn = connection || mongoose;
  return (conn.models && conn.models[MODEL_NAME]) || conn.model(MODEL_NAME, ruleAuditLogSchema, COLLECTION_NAME);
}

/**
 * Validates and normalises one trigger entry. Returns a plain object or throws
 * a ValidationError that names the offending fields. No database is needed.
 */
function buildRuleAuditLog(input) {
  const Model = getRuleAuditLogModel();
  const doc = new Model(input || {});
  const error = doc.validateSync();
  if (error) throw error;
  const plain = doc.toObject({ versionKey: false, minimize: false }); // keep a null actionDispatched
  delete plain._id; // let the store assign it
  return plain;
}

module.exports = {
  MODEL_NAME,
  COLLECTION_NAME,
  ACTION_MAX_LENGTH,
  ruleAuditLogSchema,
  getRuleAuditLogModel,
  buildRuleAuditLog
};
