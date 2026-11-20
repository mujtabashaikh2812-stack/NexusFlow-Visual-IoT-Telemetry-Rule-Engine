'use strict';

/**
 * TelemetryPoint: native MongoDB 5.0+ Time-Series collection schema.
 *
 *   timeseries: { timeField: 'timestamp', metaField: 'metadata', granularity: 'seconds' }
 *
 *  - timestamp : when the sensor took the reading (the time field)
 *  - metadata  : { deviceId, sensorType, location, model } - the fields that
 *                identify the source of the series (the meta field)
 *  - value     : the measured number
 *  - unit      : optional unit label, e.g. 'C' or 'bar'
 *
 * Loading this file never touches the network. The collection is created and
 * indexed explicitly (see ../indexes/timeSeriesIndexes.js), so tests and CI
 * runs work with no database. buildTelemetryDocument() returns a validated
 * plain object that can be written to a real collection or to the in-memory
 * fallback store alike.
 */

const mongoose = require('mongoose');

const MODEL_NAME = 'TelemetryPoint';
const COLLECTION_NAME = 'telemetry_points';

const TIME_SERIES_OPTIONS = Object.freeze({
  timeField: 'timestamp',
  metaField: 'metadata',
  granularity: 'seconds'
});

const metadataSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, trim: true },
    sensorType: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    model: { type: String, trim: true }
  },
  { _id: false }
);

const telemetryPointSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    metadata: { type: metadataSchema, required: true },
    value: { type: Number, required: true, validate: { validator: Number.isFinite, message: 'value must be a finite number' } },
    unit: { type: String, trim: true }
  },
  {
    timeseries: { ...TIME_SERIES_OPTIONS },
    versionKey: false,
    // Collection creation and index builds are explicit, never a side effect of loading the model.
    autoCreate: false,
    autoIndex: false
  }
);

/**
 * Returns the TelemetryPoint model for a connection (default: the shared
 * mongoose connection). Safe to call repeatedly; the model is compiled once.
 */
function getTelemetryPointModel(connection) {
  const conn = connection || mongoose;
  return (conn.models && conn.models[MODEL_NAME]) || conn.model(MODEL_NAME, telemetryPointSchema, COLLECTION_NAME);
}

/** Options to pass to a native createCollection() call for the same time-series collection. */
function getCreateCollectionOptions() {
  return { timeseries: { ...TIME_SERIES_OPTIONS } };
}

/**
 * Validates and normalises one reading. Returns a plain object
 * { timestamp, metadata, value, unit? } or throws a ValidationError that names
 * the offending fields. No database connection is needed.
 */
function buildTelemetryDocument(input) {
  const Model = getTelemetryPointModel();
  const doc = new Model(input || {});
  const error = doc.validateSync();
  if (error) throw error;
  const plain = doc.toObject({ versionKey: false });
  delete plain._id; // let the store assign it
  return plain;
}

module.exports = {
  MODEL_NAME,
  COLLECTION_NAME,
  TIME_SERIES_OPTIONS,
  telemetryPointSchema,
  getTelemetryPointModel,
  getCreateCollectionOptions,
  buildTelemetryDocument
};
