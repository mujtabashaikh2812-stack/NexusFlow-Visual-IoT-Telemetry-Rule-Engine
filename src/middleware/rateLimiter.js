'use strict';

/**
 * NexusFlow Token Bucket Rate Limiter & Backpressure Monitor
 * 
 * Provides high-throughput in-memory rate limiting and backpressure protection
 * for the telemetry ingestion pipeline:
 *  - Token Bucket algorithm supporting configurable capacity and replenishment rates
 *  - Per-device throttling to isolate and contain rogue/flapping IoT hardware sensors
 *  - Global ingestion firewall protecting event loop from aggregate sensor spam
 *  - Dynamic backpressure monitor tracking concurrent in-flight requests and event loop lag
 *  - Automatic memory cleanup (TTL sweep) preventing memory leaks across device fleets
 */

class TokenBucket {
  /**
   * @param {Object} options
   * @param {number} [options.capacity=60] - Maximum burst capacity
   * @param {number} [options.refillRate=10] - Tokens added per second
   * @param {number} [options.initialTokens] - Starting tokens (defaults to capacity)
   */
  constructor({ capacity = 60, refillRate = 10, initialTokens } = {}) {
    if (capacity <= 0) throw new Error('Capacity must be greater than 0');
    if (refillRate <= 0) throw new Error('Refill rate must be greater than 0');

    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = typeof initialTokens === 'number' ? Math.min(initialTokens, capacity) : capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Refills tokens based on elapsed wall-clock time.
   * @returns {number} Current tokens
   */
  refill() {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillTime) / 1000);

    if (elapsedSeconds > 0) {
      const tokensToAdd = elapsedSeconds * this.refillRate;
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }

    return this.tokens;
  }

  /**
   * Attempts to consume specified number of tokens.
   * @param {number} [count=1]
   * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
   */
  tryConsume(count = 1) {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      const resetMs = this.calculateTimeToFullMs();
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        resetMs,
      };
    }

    // Calculate time needed to replenish enough tokens to permit 'count'
    const deficit = count - this.tokens;
    const waitSeconds = deficit / this.refillRate;
    const resetMs = Math.ceil(waitSeconds * 1000);

    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      resetMs: Math.max(1, resetMs),
    };
  }

  /**
   * Calculates milliseconds needed to refill bucket back to full capacity.
   * @returns {number}
   */
  calculateTimeToFullMs() {
    const missing = this.capacity - this.tokens;
    if (missing <= 0) return 0;
    return Math.ceil((missing / this.refillRate) * 1000);
  }

  /**
   * Resets bucket back to full capacity.
   */
  reset() {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }
}

class BackpressureMonitor {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxConcurrent=250] - Threshold of concurrent in-flight requests before warning
   * @param {number} [options.criticalConcurrent=500] - Hard threshold triggering proactive load shedding
   * @param {number} [options.maxEventLoopLagMs=500] - Maximum tolerable event loop lag in ms under load
   */
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 250;
    this.criticalConcurrent = options.criticalConcurrent || 500;
    this.maxEventLoopLagMs = options.maxEventLoopLagMs || 500;

    this.activeInFlight = 0;
    this.totalShedRequests = 0;
    this.lastLagCheck = Date.now();
    this.cachedLagMs = 0;

    // Background low-overhead heartbeat to sample event loop delay
    this.lagCheckTimer = null;
    this.startLagMonitor();
  }

  startLagMonitor() {
    let expected = Date.now() + 100;
    this.lagCheckTimer = setInterval(() => {
      const now = Date.now();
      this.cachedLagMs = Math.max(0, now - expected);
      expected = now + 100;
    }, 100);

    // Ensure timer does not prevent process exit in tests
    if (this.lagCheckTimer && typeof this.lagCheckTimer.unref === 'function') {
      this.lagCheckTimer.unref();
    }
  }

  stopLagMonitor() {
    if (this.lagCheckTimer) {
      clearInterval(this.lagCheckTimer);
      this.lagCheckTimer = null;
    }
  }

  /**
   * Checks current backpressure status.
   * Load shedding occurs if in-flight requests exceed critical concurrency limits,
   * or when significant concurrency combines with severe event loop delay.
   * @returns {{ status: 'NORMAL'|'WARNING'|'CRITICAL', isOverloaded: boolean, inFlight: number, lagMs: number }}
   */
  getStatus() {
    const lagMs = this.cachedLagMs;
    const inFlight = this.activeInFlight;

    let status = 'NORMAL';
    let isOverloaded = false;

    if (inFlight >= this.criticalConcurrent || (inFlight >= 50 && lagMs >= this.maxEventLoopLagMs)) {
      status = 'CRITICAL';
      isOverloaded = true;
    } else if (inFlight >= this.maxConcurrent || lagMs >= this.maxEventLoopLagMs) {
      status = 'WARNING';
    }

    return {
      status,
      isOverloaded,
      inFlight,
      lagMs,
      totalShedRequests: this.totalShedRequests,
    };
  }

  recordShed() {
    this.totalShedRequests += 1;
  }
}

class TelemetryRateLimiter {
  /**
   * @param {Object} [options]
   * @param {number} [options.deviceCapacity=60] - Burst bucket capacity per IoT device
   * @param {number} [options.deviceRefillRate=10] - Token replenishment rate (tokens/sec) per device
   * @param {number} [options.globalCapacity=1000] - Server-wide aggregate burst capacity
   * @param {number} [options.globalRefillRate=500] - Server-wide replenishment rate (tokens/sec)
   * @param {number} [options.bucketTtlMs=300000] - Idle bucket eviction TTL (default 5 mins)
   * @param {BackpressureMonitor} [options.backpressureMonitor]
   */
  constructor(options = {}) {
    this.deviceCapacity = options.deviceCapacity || 60;
    this.deviceRefillRate = options.deviceRefillRate || 10;
    this.globalCapacity = options.globalCapacity || 1000;
    this.globalRefillRate = options.globalRefillRate || 500;
    this.bucketTtlMs = options.bucketTtlMs || 300000; // 5 minutes

    // Global bucket for server-wide aggregate ingress protection
    this.globalBucket = new TokenBucket({
      capacity: this.globalCapacity,
      refillRate: this.globalRefillRate,
    });

    /** @type {Map<string, { bucket: TokenBucket, lastAccess: number }>} */
    this.deviceBuckets = new Map();

    this.backpressureMonitor = options.backpressureMonitor || new BackpressureMonitor();

    // Telemetry and auditing metrics
    this.metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      throttledDeviceRequests: 0,
      throttledGlobalRequests: 0,
      throttledDevices: new Map(), // deviceId -> count
    };

    // Periodic sweep for dormant device buckets to preserve memory
    this.cleanupTimer = setInterval(() => this.evictStaleBuckets(), 60000);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Retrieves or creates a TokenBucket for a specific device.
   * @param {string} deviceId
   * @returns {TokenBucket}
   */
  getDeviceBucket(deviceId) {
    const key = String(deviceId || 'anonymous').trim();
    const now = Date.now();
    let entry = this.deviceBuckets.get(key);

    if (!entry) {
      entry = {
        bucket: new TokenBucket({
          capacity: this.deviceCapacity,
          refillRate: this.deviceRefillRate,
        }),
        lastAccess: now,
      };
      this.deviceBuckets.set(key, entry);
    } else {
      entry.lastAccess = now;
    }

    return entry.bucket;
  }

  /**
   * Evicts idle device buckets that have exceeded TTL.
   * @returns {number} Count of evicted buckets
   */
  evictStaleBuckets() {
    const now = Date.now();
    let evictedCount = 0;

    for (const [key, entry] of this.deviceBuckets.entries()) {
      if (now - entry.lastAccess > this.bucketTtlMs) {
        this.deviceBuckets.delete(key);
        evictedCount += 1;
      }
    }

    return evictedCount;
  }

  /**
   * Resets rate limiter state for a specific device or all devices.
   * @param {string} [deviceId]
   */
  reset(deviceId) {
    if (deviceId) {
      const entry = this.deviceBuckets.get(String(deviceId));
      if (entry) {
        entry.bucket.reset();
      }
    } else {
      this.deviceBuckets.clear();
      this.globalBucket.reset();
      this.metrics.throttledDevices.clear();
      this.metrics.throttledDeviceRequests = 0;
      this.metrics.throttledGlobalRequests = 0;
      this.metrics.totalRequests = 0;
      this.metrics.allowedRequests = 0;
    }
  }

  /**
   * Inspects current rate-limiter and backpressure statistics.
   * @returns {Object}
   */
  getStats() {
    const topThrottled = Array.from(this.metrics.throttledDevices.entries())
      .map(([deviceId, count]) => ({ deviceId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      activeDeviceBuckets: this.deviceBuckets.size,
      globalRemainingTokens: Math.floor(this.globalBucket.refill()),
      globalCapacity: this.globalCapacity,
      globalRefillRate: this.globalRefillRate,
      deviceCapacity: this.deviceCapacity,
      deviceRefillRate: this.deviceRefillRate,
      metrics: {
        totalRequests: this.metrics.totalRequests,
        allowedRequests: this.metrics.allowedRequests,
        throttledDeviceRequests: this.metrics.throttledDeviceRequests,
        throttledGlobalRequests: this.metrics.throttledGlobalRequests,
        topThrottledDevices: topThrottled,
      },
      backpressure: this.backpressureMonitor.getStatus(),
    };
  }

  /**
   * Express middleware factory for rate-limiting and backpressure shedding.
   * @returns {Function} Express middleware (req, res, next)
   */
  middleware() {
    return (req, res, next) => {
      this.metrics.totalRequests += 1;

      // 1. Backpressure Check & Load Shedding
      const bpStatus = this.backpressureMonitor.getStatus();
      if (bpStatus.isOverloaded) {
        this.backpressureMonitor.recordShed();
        res.setHeader('Retry-After', '2');
        return res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          code: 'BACKPRESSURE_LOAD_SHEDDING',
          message: 'Server is currently experiencing critical backpressure; request shed to prevent cascading failure',
          inFlightRequests: bpStatus.inFlight,
          eventLoopLagMs: bpStatus.lagMs,
        });
      }

      // 2. Global Rate Limit Check
      const globalCheck = this.globalBucket.tryConsume(1);
      if (!globalCheck.allowed) {
        this.metrics.throttledGlobalRequests += 1;
        const retryAfterSeconds = Math.max(1, Math.ceil(globalCheck.resetMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.setHeader('X-RateLimit-Limit', String(this.globalCapacity));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(retryAfterSeconds));

        return res.status(429).json({
          error: 'TOO_MANY_REQUESTS',
          code: 'GLOBAL_RATE_LIMIT_EXCEEDED',
          message: 'Aggregate server telemetry ingestion throughput capacity exceeded',
          retryAfter: retryAfterSeconds,
        });
      }

      // 3. Extract Device ID from Payload or Headers
      const deviceId =
        (req.body && req.body.deviceId) ||
        req.headers['x-device-id'] ||
        req.ip ||
        'anonymous';

      // 4. Device-Level Rate Limit Check
      const deviceBucket = this.getDeviceBucket(deviceId);
      const deviceCheck = deviceBucket.tryConsume(1);

      const resetSeconds = Math.max(1, Math.ceil(deviceCheck.resetMs / 1000));
      res.setHeader('X-RateLimit-Limit', String(this.deviceCapacity));
      res.setHeader('X-RateLimit-Remaining', String(deviceCheck.remaining));
      res.setHeader('X-RateLimit-Reset', String(resetSeconds));

      if (!deviceCheck.allowed) {
        this.metrics.throttledDeviceRequests += 1;
        const count = (this.metrics.throttledDevices.get(deviceId) || 0) + 1;
        this.metrics.throttledDevices.set(deviceId, count);

        res.setHeader('Retry-After', String(resetSeconds));
        return res.status(429).json({
          error: 'TOO_MANY_REQUESTS',
          code: 'DEVICE_RATE_LIMIT_EXCEEDED',
          message: `Telemetry ingestion rate limit exceeded for device "${deviceId}". Burst capacity is ${this.deviceCapacity} with a refill rate of ${this.deviceRefillRate}/sec.`,
          deviceId,
          retryAfter: resetSeconds,
        });
      }

      // 5. Track in-flight request lifecycle for backpressure accounting
      this.backpressureMonitor.activeInFlight += 1;
      this.metrics.allowedRequests += 1;

      let closed = false;
      const cleanup = () => {
        if (!closed) {
          closed = true;
          this.backpressureMonitor.activeInFlight = Math.max(0, this.backpressureMonitor.activeInFlight - 1);
        }
      };

      res.on('finish', cleanup);
      res.on('close', cleanup);

      return next();
    };
  }
}

// Default instances for system-wide injection
const defaultBackpressureMonitor = new BackpressureMonitor();
const defaultRateLimiter = new TelemetryRateLimiter({
  deviceCapacity: 60,
  deviceRefillRate: 10,
  globalCapacity: 1000,
  globalRefillRate: 500,
  backpressureMonitor: defaultBackpressureMonitor,
});

module.exports = {
  TokenBucket,
  BackpressureMonitor,
  TelemetryRateLimiter,
  defaultBackpressureMonitor,
  defaultRateLimiter,
};
