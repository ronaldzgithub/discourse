import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  buildPlan,
  reviewActionSha256,
  verifyWebhook,
} from './foundry_huaxiaobao_contract.mjs';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const baseCommand = {
  schema_version: 'foundry.huaxiaobao.discourse.command.v1',
  command_id: 'command-opaque-1',
  task_revision: 2,
  instance_ref: 'discourse-instance-opaque-1',
};
const safeOutboundPolicy = {
  disable_emails: 'yes',
  allow_email_invites: false,
  send_welcome_message: false,
  send_tl1_welcome_message: false,
  send_tl2_promotion_message: false,
  default_email_digest_frequency: 0,
  enable_desktop_push_notifications: false,
  push_notifications_prompt: false,
};

test('discussion, unanswered, queue and notification reads are GET-only', () => {
  for (const operation of ['topics_read', 'unanswered_read', 'review_queue_read', 'notifications_read']) {
    const plan = buildPlan({ ...baseCommand, operation, page: 0 });
    assert.equal(plan.query_only, true);
    assert.deepEqual(plan.requests.map(request => request.method), ['GET']);
    assert.equal(plan.external_message_performed, false);
  }
  const notifications = buildPlan({ ...baseCommand, operation: 'notifications_read', page: 0 });
  assert.equal(notifications.requests[0].query.silent, true);
  assert.equal(notifications.notification_seen_state_mutation_allowed, false);
});

test('outbound inventory makes mail, welcome, invite, digest and push default-off', () => {
  const plan = buildPlan({ ...baseCommand, operation: 'outbound_inventory' });
  assert.deepEqual(plan.required_default_off, safeOutboundPolicy);
  assert.equal(plan.native_defaults_are_not_safe_for_isolation, true);
  assert.equal(plan.requests.length, 0);
});

function approvedReviewCommand(overrides = {}) {
  const reviewableId = 41;
  const version = 3;
  const actionId = 'approve_post';
  return {
    ...baseCommand,
    operation: 'review_action',
    reviewable_id: reviewableId,
    reviewable_version: version,
    action_id: actionId,
    prepared_by_ref: 'worker-opaque-1',
    reviewer_ref: 'moderator-opaque-1',
    outbound_policy: safeOutboundPolicy,
    approval: {
      reference: 'approval-opaque-1',
      expires_at: '2030-01-02T00:00:00.000Z',
      action_sha256: reviewActionSha256(reviewableId, version, actionId),
    },
    ...overrides,
  };
}

test('review action is queue-only, versioned, independently reviewed and read back', () => {
  const plan = buildPlan(approvedReviewCommand(), { now: NOW });
  assert.equal(plan.queue_only, true);
  assert.equal(plan.staff_direct_post_allowed, false);
  assert.equal(plan.independent_reviewer_verified, true);
  assert.equal(plan.precondition_read.require.version, 3);
  assert.deepEqual(plan.requests[0].body, { version: 3 });
  assert.equal(plan.verification.approved_post_readback.method, 'GET');
  assert.deepEqual(plan.external_notification_controls, safeOutboundPolicy);
});

test('worker cannot review their own delivery and direct/messaging actions are excluded', () => {
  assert.throws(
    () => buildPlan(approvedReviewCommand({ reviewer_ref: 'worker-opaque-1' }), { now: NOW }),
    /must differ/,
  );
  assert.throws(
    () => buildPlan(approvedReviewCommand({ action_id: 'revise_and_reject_post' }), { now: NOW }),
    /direct post creation and messaging are excluded/,
  );
});

test('review action fails closed for unsafe outbound settings or stale approval', () => {
  assert.throws(
    () =>
      buildPlan(
        approvedReviewCommand({ outbound_policy: { ...safeOutboundPolicy, disable_emails: 'no' } }),
        { now: NOW },
      ),
    /disable_emails must equal/,
  );
  const expired = approvedReviewCommand();
  expired.approval.expires_at = '2029-12-31T23:59:59.000Z';
  assert.throws(() => buildPlan(expired, { now: NOW }), /approval is expired/);
});

test('native webhook HMAC is verified and retry event IDs do not defeat dedupe', () => {
  const secret = 'test-only-secret';
  const rawBody = JSON.stringify({
    post: { id: 73, post_number: 2, updated_at: '2030-01-01T00:00:00.000Z' },
  });
  const envelopeFor = eventId => ({
    schema_version: 'foundry.huaxiaobao.discourse.webhook-envelope.v1',
    expected_instance: 'https://community.example',
    raw_body: rawBody,
    headers: {
      'X-Discourse-Instance': 'https://community.example',
      'X-Discourse-Event-Id': eventId,
      'X-Discourse-Event-Type': 'post',
      'X-Discourse-Event': 'post_created',
      'X-Discourse-Event-Signature': `sha256=${createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')}`,
    },
  });

  const first = verifyWebhook(envelopeFor('101'), secret);
  const duplicate = verifyWebhook(envelopeFor('102'), secret);
  assert.equal(first.authenticated, true);
  assert.equal(first.deduplication_key, duplicate.deduplication_key);
  assert.equal(first.readback.path, '/posts/73.json');

  const tampered = envelopeFor('101');
  tampered.raw_body = `${rawBody} `;
  assert.throws(() => verifyWebhook(tampered, secret), /signature is invalid/);
});

test('webhook rejects wrong instance, unsupported type and missing readback identity', () => {
  const secret = 'test-only-secret';
  const rawBody = JSON.stringify({ post: { id: 73 } });
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const envelope = {
    schema_version: 'foundry.huaxiaobao.discourse.webhook-envelope.v1',
    expected_instance: 'https://community.example',
    raw_body: rawBody,
    headers: {
      'X-Discourse-Instance': 'https://wrong.example',
      'X-Discourse-Event-Id': '101',
      'X-Discourse-Event-Type': 'post',
      'X-Discourse-Event': 'post_created',
      'X-Discourse-Event-Signature': signature,
    },
  };
  assert.throws(() => verifyWebhook(envelope, secret), /instance does not match/);
  envelope.headers['X-Discourse-Instance'] = envelope.expected_instance;
  envelope.headers['X-Discourse-Event-Type'] = 'user';
  assert.throws(() => verifyWebhook(envelope, secret), /unsupported webhook event type/);
});

test('credentials are rejected from plan inputs', () => {
  assert.throws(
    () => buildPlan({ ...baseCommand, operation: 'topics_read', page: 0, api_key: 'must-not-be-here' }),
    /credential storage/,
  );
});
