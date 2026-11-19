'use strict';

/**
 * Manual proof for Day 1. Runs against whatever is available: a real MongoDB
 * if one is reachable, otherwise the in-memory fallback.
 *
 *   npm run smoke:db
 *   MONGODB_URI=mongodb://127.0.0.1:27099/nexusflow npm run smoke:db   # unreachable -> fallback
 */

const assert = require('node:assert/strict');
const { getDatabase } = require('./dbConnection');

async function main() {
  const db = getDatabase();
  let failure = null;
  try {
    await db.connect();
    const s = db.getStats();
    console.log(`mode             : ${s.mode}`);
    console.log(`fallback         : ${s.fallback}`);
    console.log(`attempts         : ${s.attempts}`);
    console.log(`host             : ${s.host}`);
    console.log(`database         : ${s.database}`);
    console.log(`isProductionUri  : ${s.isProductionUri}`);
    console.log(`lastError        : ${s.lastError}`);

    const readings = db.collection('smoke_readings');
    await readings.deleteMany({});
    const now = Date.now();
    await readings.insertMany([
      { deviceId: 'pump-01', sensor: 'pressure', value: 4.1, ts: new Date(now) },
      { deviceId: 'pump-01', sensor: 'pressure', value: 4.3, ts: new Date(now + 1000) },
      { deviceId: 'pump-01', sensor: 'temperature', value: 61.5, ts: new Date(now + 2000) },
      { deviceId: 'valve-07', sensor: 'position', value: 0.8, ts: new Date(now + 3000) },
      { deviceId: 'valve-07', sensor: 'position', value: 0.9, ts: new Date(now + 4000) }
    ]);

    const pump = await readings.find({ deviceId: 'pump-01' }).toArray();
    const valve = await readings.find({ deviceId: 'valve-07' }).toArray();
    console.log(`pump-01 readings : ${pump.length}`);
    console.log(`valve-07 readings: ${valve.length}`);
    assert.equal(pump.length, 3, 'expected 3 readings for pump-01');
    assert.equal(valve.length, 2, 'expected 2 readings for valve-07');

    const removed = await readings.deleteMany({});
    console.log(`cleaned up       : ${removed.deletedCount} documents`);
  } catch (err) {
    failure = err;
  }

  try {
    await db.close();
  } catch (err) {
    failure = failure || err;
  }

  if (failure) {
    console.log(`result : FAIL (${failure.message})`);
    process.exitCode = 1;
  } else {
    console.log('result : PASS');
  }
}

main();
