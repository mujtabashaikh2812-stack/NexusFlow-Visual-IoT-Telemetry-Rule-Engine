'use strict';

/**
 * Device: the asset catalog entry for one physical or virtual sensor unit.
 *
 *  - deviceId        : stable business key, unique (matches the metadata.deviceId of telemetry)
 *  - name            : human label, e.g. "Turbine 1 bearing monitor"
 *  - sensors         : the sensors on the unit: { sensorType, unit? }; sensor types are unique per device
 *  - firmwareVersion : firmware the unit reports, e.g. "2.4.1" (optional)
 *  - status          : online | offline | maintenance | retired (new units start offline)
 *  - lastSeenAt      : when a reading last arrived from the unit (null until the first one)
 *
 * Loading this file never touches the network. The collection and its unique
 * deviceId index are created explicitly, so tests and CI runs work with no
 * database. buildDevice() returns a validated plain object that can be written
 * to a real collection or to the in-memory fallback store alike.
 */

const mongoose = require('mongoose');

const MODEL_NAME = 'Device';
const COLLECTION_NAME = 'devices';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SENSOR_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const FIRMWARE_PATTERN = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const DEVICE_STATUSES = Object.freeze(['online', 'offline', 'maintenance', 'retired']);
const DEFAULT_STATUS = 'offline';

const sensorSchema = new mongoose.Schema(
  {
    sensorType: {
      type: String,
      required: true,
      trim: true,
      match: [SENSOR_TYPE_PATTERN, 'sensorType must be lowercase letters, digits or "_", starting with a letter']
    },
    unit: { type: String, trim: true, maxlength: 16 }
  },
  { _id: false }
);

const deviceSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      trim: true,
      match: [DEVICE_ID_PATTERN, 'deviceId may use letters, digits, "_" and "-" only (1 to 64 characters)']
    },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    sensors: {
      type: [sensorSchema],
      default: () => [],
      validate: {
        validator: (sensors) => new Set(sensors.map((s) => s.sensorType)).size === sensors.length,
        message: 'each sensor type may appear only once on a device'
      }
    },
    firmwareVersion: {
      type: String,
      trim: true,
      match: [FIRMWARE_PATTERN, 'firmwareVersion must look like 2.4.1']
    },
    status: { type: String, required: true, enum: { values: DEVICE_STATUSES, message: 'status must be one of: ' + DEVICE_STATUSES.join(', ') }, default: DEFAULT_STATUS },
    lastSeenAt: { type: Date, default: null }
  },
  {
    versionKey: false,
    timestamps: true,
    // Collection creation and index builds are explicit, never a side effect of loading the model.
    autoCreate: false,
    autoIndex: false
  }
);

deviceSchema.index({ deviceId: 1 }, { unique: true, name: 'deviceId_1' });

/**
 * Returns the Device model for a connection (default: the shared mongoose
 * connection). Safe to call repeatedly; the model is compiled once.
 */
function getDeviceModel(connection) {
  const conn = connection || mongoose;
  return (conn.models && conn.models[MODEL_NAME]) || conn.model(MODEL_NAME, deviceSchema, COLLECTION_NAME);
}

/**
 * Validates and normalises one catalog entry. Returns a plain object or throws
 * a ValidationError that names the offending fields. No database is needed.
 */
function buildDevice(input) {
  const Model = getDeviceModel();
  const doc = new Model(input || {});
  const error = doc.validateSync();
  if (error) throw error;
  const plain = doc.toObject({ versionKey: false, minimize: false }); // keep empty sensor lists and nulls
  delete plain._id; // let the store assign it
  return plain;
}

module.exports = {
  MODEL_NAME,
  COLLECTION_NAME,
  DEVICE_ID_PATTERN,
  SENSOR_TYPE_PATTERN,
  DEVICE_STATUSES,
  DEFAULT_STATUS,
  deviceSchema,
  getDeviceModel,
  buildDevice
};
