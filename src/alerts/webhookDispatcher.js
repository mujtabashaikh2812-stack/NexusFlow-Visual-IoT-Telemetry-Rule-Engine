'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

/**
 * NexusFlow Outbound Webhook Dispatcher
 * Resilient HTTP POST webhook dispatcher featuring automated retries,
 * exponential backoff, cryptographic HMAC-SHA256 signature verification headers,
 * and delivery metrics.
 */

class WebhookDispatcher {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxRetries=3] - Maximum retry attempts upon failure
   * @param {number} [options.initialBackoffMs=100] - Base delay before first retry
   * @param {number} [options.backoffMultiplier=2] - Exponential backoff multiplier
   * @param {number} [options.timeoutMs=5000] - HTTP socket timeout in ms
   * @param {string} [options.defaultSecret] - Default HMAC secret key
   */
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 100;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.defaultSecret = options.defaultSecret || 'nexusflow-webhook-default-secret';

    this.metrics = {
      totalDispatched: 0,
      successfulDeliveries: 0,
      failedDeliveries: 0,
      retriesCount: 0,
    };

    /** @type {Array<Object>} In-memory ring buffer of recent deliveries */
    this.recentDeliveries = [];
    this.maxHistorySize = 50;
  }

  /**
   * Computes HMAC-SHA256 signature for payload verification.
   * @param {string} body - Serialized string payload
   * @param {string} secret - Secret key
   * @returns {string} Hex encoded signature
   */
  computeSignature(body, secret) {
    return crypto
      .createHmac('sha256', secret || this.defaultSecret)
      .update(body, 'utf8')
      .digest('hex');
  }

  /**
   * Dispatches an alert or event payload to a webhook destination URL.
   * Automatically retries transient 5xx errors or network drops with exponential backoff.
   * 
   * @param {string} targetUrl - Destination HTTP/HTTPS endpoint
   * @param {Object} payload - Event payload object to deliver
   * @param {Object} [config]
   * @param {string} [config.secret] - Destination HMAC secret
   * @param {number} [config.maxRetries] - Custom max retries
   * @param {Object} [config.customHeaders] - Additional HTTP headers
   * @returns {Promise<Object>} Delivery report
   */
  async dispatch(targetUrl, payload, config = {}) {
    if (!targetUrl || typeof targetUrl !== 'string') {
      throw new Error('Invalid target URL: Webhook dispatch requires a valid HTTP/HTTPS URL');
    }

    this.metrics.totalDispatched += 1;
    const deliveryId = crypto.randomUUID ? crypto.randomUUID() : `dlv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const secret = config.secret || this.defaultSecret;
    const maxRetries = config.maxRetries ?? this.maxRetries;
    const customHeaders = config.customHeaders || {};

    const serializedPayload = JSON.stringify(payload || {});
    const signature = this.computeSignature(serializedPayload, secret);
    const timestamp = new Date().toISOString();

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serializedPayload),
      'User-Agent': 'NexusFlow-WebhookDispatcher/1.0',
      'X-NexusFlow-Delivery-Id': deliveryId,
      'X-NexusFlow-Timestamp': timestamp,
      'X-NexusFlow-Signature': `sha256=${signature}`,
      ...customHeaders,
    };

    let attempt = 0;
    let lastError = null;
    let statusCode = null;
    const startTime = Date.now();

    while (attempt <= maxRetries) {
      attempt += 1;

      try {
        const response = await this._sendHttpRequest(targetUrl, serializedPayload, headers);
        statusCode = response.statusCode;

        // 2xx response signals successful delivery
        if (statusCode >= 200 && statusCode < 300) {
          this.metrics.successfulDeliveries += 1;
          const deliveryReport = {
            deliveryId,
            targetUrl,
            status: 'delivered',
            statusCode,
            attempts: attempt,
            durationMs: Date.now() - startTime,
            timestamp,
          };
          this._recordDelivery(deliveryReport);
          return deliveryReport;
        }

        // 4xx errors (client faults) should NOT be retried (except 429 rate limit)
        if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          throw new Error(`Webhook recipient rejected payload with HTTP status ${statusCode}`);
        }

        throw new Error(`Webhook server responded with transient error HTTP ${statusCode}`);
      } catch (err) {
        lastError = err;

        // If client error (4xx except 429), break immediately
        if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          break;
        }

        if (attempt <= maxRetries) {
          this.metrics.retriesCount += 1;
          const backoffDelay = this.initialBackoffMs * Math.pow(this.backoffMultiplier, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
    }

    // Exhausted retries or client rejection
    this.metrics.failedDeliveries += 1;
    const failureReport = {
      deliveryId,
      targetUrl,
      status: 'failed',
      statusCode,
      attempts: attempt,
      durationMs: Date.now() - startTime,
      error: lastError ? lastError.message : 'Unknown dispatch error',
      timestamp,
    };

    this._recordDelivery(failureReport);
    return failureReport;
  }

  /**
   * Internal HTTP/HTTPS request execution helper.
   * @private
   */
  _sendHttpRequest(urlStr, data, headers) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers,
        timeout: this.timeoutMs,
      };

      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Webhook request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(data);
      req.end();
    });
  }

  _recordDelivery(report) {
    this.recentDeliveries.unshift(report);
    if (this.recentDeliveries.length > this.maxHistorySize) {
      this.recentDeliveries.pop();
    }
  }

  /**
   * Returns runtime metrics and delivery history.
   */
  getStats() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalDispatched > 0
        ? Math.round((this.metrics.successfulDeliveries / this.metrics.totalDispatched) * 1000) / 10
        : 100,
      recentCount: this.recentDeliveries.length,
      recentDeliveries: [...this.recentDeliveries],
    };
  }

  reset() {
    this.metrics.totalDispatched = 0;
    this.metrics.successfulDeliveries = 0;
    this.metrics.failedDeliveries = 0;
    this.metrics.retriesCount = 0;
    this.recentDeliveries = [];
  }
}

const defaultWebhookDispatcher = new WebhookDispatcher();

module.exports = {
  WebhookDispatcher,
  defaultWebhookDispatcher,
};
