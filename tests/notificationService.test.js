'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SmsAdapter,
  SlackAdapter,
  EmailAdapter,
  NotificationService,
  defaultNotificationService,
} = require('../src/alerts/notificationService');

test('SmsAdapter: validates E.164 phone numbers and calculates GSM segments', async () => {
  const adapter = new SmsAdapter({ fromNumber: '+15550001111' });

  // Rejects invalid phone numbers without leading plus
  await assert.rejects(
    () => adapter.send({ target: '9876543210', message: 'Test alert' }),
    /E.164 international format required/
  );

  // Rejects empty message
  await assert.rejects(
    () => adapter.send({ target: '+919876543210', message: '   ' }),
    /SMS notification message cannot be empty/
  );

  // Successfully formats standard SMS
  const receipt = await adapter.send({
    target: '+919876543210',
    message: 'High pressure alert on Boiler 4: 120 PSI',
    severity: 'critical',
    alertId: 'alt-sms-1',
  });

  assert.equal(receipt.channel, 'sms');
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.to, '+919876543210');
  assert.equal(receipt.from, '+15550001111');
  assert.equal(receipt.segments, 1);
  assert.ok(receipt.messageSid.startsWith('SM'));
});

test('SlackAdapter: generates Block Kit payload with severity color coding', async () => {
  const adapter = new SlackAdapter({ defaultChannel: '#iot-ops' });

  const criticalReceipt = await adapter.send({
    target: '#iot-critical',
    message: 'Turbine Vibration Exceeded Tolerable Limit',
    severity: 'critical',
    ruleId: 'rule-vib-01',
    value: 18.5,
  });

  assert.equal(criticalReceipt.channel, 'slack');
  assert.equal(criticalReceipt.target, '#iot-critical');
  assert.equal(criticalReceipt.payload.attachments[0].color, '#E01E5A'); // Red
  assert.ok(criticalReceipt.payload.text.includes('CRITICAL'));

  const warningReceipt = await adapter.send({
    message: 'Temperature drifting above baseline',
    severity: 'warning',
  });
  assert.equal(warningReceipt.payload.attachments[0].color, '#ECB22E'); // Yellow
});

test('EmailAdapter: constructs HTML email digest and tags subject with severity', async () => {
  const adapter = new EmailAdapter({ fromAddress: 'monitor@nexusflow.io' });

  await assert.rejects(
    () => adapter.send({ target: 'invalid-email-address', message: 'Alert' }),
    /Invalid recipient email address/
  );

  const receipt = await adapter.send({
    target: 'ops-team@enterprise.com',
    message: 'Battery Voltage Low on IoT Sensor Node 12',
    severity: 'warning',
    ruleId: 'rule-batt-12',
  });

  assert.equal(receipt.channel, 'email');
  assert.equal(receipt.to, 'ops-team@enterprise.com');
  assert.equal(receipt.from, 'monitor@nexusflow.io');
  assert.ok(receipt.subject.includes('[NexusFlow Alert] [WARNING]'));
  assert.ok(receipt.htmlBody.includes('Battery Voltage Low on IoT Sensor Node 12'));
});

test('NotificationService: routes multi-channel alerts and tracks metrics', async () => {
  const service = new NotificationService();

  const rSms = await service.notify({
    channel: 'sms',
    target: '+919988776655',
    message: 'Critical pump overload',
    severity: 'critical',
  });
  assert.equal(rSms.channel, 'sms');

  const rSlack = await service.notify({
    channel: 'slack',
    target: '#alerts',
    message: 'Pump overload resolved',
    severity: 'info',
  });
  assert.equal(rSlack.channel, 'slack');

  const rEmail = await service.notify({
    channel: 'email',
    target: 'engineer@corp.com',
    message: 'System daily summary',
  });
  assert.equal(rEmail.channel, 'email');

  const stats = service.getStats();
  assert.equal(stats.totalDispatched, 3);
  assert.equal(stats.smsCount, 1);
  assert.equal(stats.slackCount, 1);
  assert.equal(stats.emailCount, 1);
  assert.equal(stats.failedCount, 0);
});

test('NotificationService: executes automatic failover when primary channel fails', async () => {
  const service = new NotificationService();

  // Primary SMS fails due to bad phone format -> Fails over to Slack
  const receipt = await service.notify({
    channel: 'sms',
    target: 'bad-phone-number',
    fallbackChannel: 'slack',
    fallbackTarget: '#fallback-ops',
    message: 'Emergency shutdown signal',
    severity: 'critical',
  });

  assert.equal(receipt.channel, 'slack');
  assert.equal(receipt.wasFailover, true);
  assert.ok(receipt.primaryError.includes('E.164'));

  const stats = service.getStats();
  assert.equal(stats.slackCount, 1);
  assert.equal(stats.smsCount, 0);
});

test('NotificationService: rejects unsupported notification channels', async () => {
  const service = new NotificationService();
  await assert.rejects(
    () => service.notify({ channel: 'pagerduty', message: 'Test' }),
    /Unsupported notification channel: "pagerduty"/
  );
});
