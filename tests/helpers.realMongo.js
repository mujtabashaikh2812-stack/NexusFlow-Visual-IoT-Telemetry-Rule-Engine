'use strict';

/**
 * Starts a throwaway real mongod through mongodb-memory-server. Returns
 * { server } on success, or { skip: '<reason>' } when it is not installed or
 * cannot start (offline CI, no binary), so tests skip instead of failing.
 * Optional `options` are passed to MongoMemoryServer.create() (e.g. extra mongod args).
 */
async function startRealMongo(options) {
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require('mongodb-memory-server'));
  } catch (err) {
    return { skip: `mongodb-memory-server is not installed: ${err.message}` };
  }
  let timer;
  try {
    const server = await Promise.race([
      MongoMemoryServer.create(options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out starting mongod after 90s')), 90000);
      })
    ]);
    return { server };
  } catch (err) {
    return { skip: `could not start a real mongod: ${String(err.message).split('\n')[0]}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { startRealMongo };
