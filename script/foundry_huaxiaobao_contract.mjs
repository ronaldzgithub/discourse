#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const COMMAND_SCHEMA = 'foundry.huaxiaobao.discourse.command.v1';
const PLAN_SCHEMA = 'foundry.huaxiaobao.discourse.http-plan.v1';
const WEBHOOK_SCHEMA = 'foundry.huaxiaobao.discourse.webhook-envelope.v1';
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|password|secret|token)/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_REVIEW_ACTIONS = new Set(['approve_post', 'reject_post']);
const SAFE_WEBHOOK_TYPES = new Set(['topic', 'post', 'reviewable', 'notification']);
const REQUIRED_OUTBOUND_POLICY = Object.freeze({
  disable_emails: 'yes',
  allow_email_invites: false,
  send_welcome_message: false,
  send_tl1_welcome_message: false,
  send_tl2_promotion_message: false,
  default_email_digest_frequency: 0,
  enable_desktop_push_notifications: false,
  push_notifications_prompt: false,
});

function fail(message) {
  throw new Error(message);
}

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
}

function assertExactKeys(value, allowedKeys, name) {
  const unexpectedKeys = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    fail(`${name} contains unsupported fields: ${unexpectedKeys.sort().join(', ')}`);
  }
}

function assertNoSecrets(value, path = 'command') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) fail(`${path}.${key} must stay in Huaxiaobao credential storage`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} must be a non-empty string`);
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
}

function assertTimestamp(value, name) {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    fail(`${name} must be a valid ISO-8601 timestamp with a timezone`);
  }
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function reviewActionSha256(reviewableId, version, actionId) {
  return sha256(`discourse:review:${reviewableId}:version:${version}:action:${actionId}`);
}

function validateBase(command) {
  assertObject(command, 'command');
  assertNoSecrets(command);
  if (command.schema_version !== COMMAND_SCHEMA) fail(`schema_version must equal ${COMMAND_SCHEMA}`);
  assertNonEmptyString(command.command_id, 'command_id');
  assertPositiveInteger(command.task_revision, 'task_revision');
  assertNonEmptyString(command.instance_ref, 'instance_ref');
}

function planBase(command) {
  return {
    schema_version: PLAN_SCHEMA,
    command_id: command.command_id,
    task_revision: command.task_revision,
    instance_ref: command.instance_ref,
    operation: command.operation,
    network_performed: false,
    external_message_performed: false,
  };
}

function validateReadCommand(command) {
  assertExactKeys(
    command,
    new Set(['schema_version', 'command_id', 'task_revision', 'instance_ref', 'operation', 'page']),
    'command',
  );
  assertNonNegativeInteger(command.page, 'page');
}

function validateOutboundPolicy(policy) {
  assertObject(policy, 'outbound_policy');
  assertExactKeys(policy, new Set(Object.keys(REQUIRED_OUTBOUND_POLICY)), 'outbound_policy');
  for (const [setting, expected] of Object.entries(REQUIRED_OUTBOUND_POLICY)) {
    if (policy[setting] !== expected) {
      fail(`outbound_policy.${setting} must equal ${JSON.stringify(expected)}`);
    }
  }
}

function validateReviewApproval(command, now) {
  assertObject(command.approval, 'approval');
  assertExactKeys(command.approval, new Set(['reference', 'expires_at', 'action_sha256']), 'approval');
  assertNonEmptyString(command.approval.reference, 'approval.reference');
  assertTimestamp(command.approval.expires_at, 'approval.expires_at');
  if (new Date(command.approval.expires_at).getTime() <= now.getTime()) fail('approval is expired');
  const expectedHash = reviewActionSha256(
    command.reviewable_id,
    command.reviewable_version,
    command.action_id,
  );
  if (command.approval.action_sha256 !== expectedHash) {
    fail('approval.action_sha256 does not match the reviewable version and action');
  }
}

export function buildPlan(command, { now = new Date() } = {}) {
  validateBase(command);

  if (command.operation === 'topics_read') {
    validateReadCommand(command);
    return {
      ...planBase(command),
      query_only: true,
      requests: [{ method: 'GET', path: '/latest.json', query: { page: command.page } }],
      evidence_limit: 'topic presence and activity are not member growth or commercial outcome evidence',
    };
  }

  if (command.operation === 'unanswered_read') {
    validateReadCommand(command);
    return {
      ...planBase(command),
      query_only: true,
      requests: [
        { method: 'GET', path: '/search.json', query: { q: 'status:noreplies', page: command.page } },
      ],
      local_check: { require_topic_posts_count: 1 },
    };
  }

  if (command.operation === 'review_queue_read') {
    validateReadCommand(command);
    return {
      ...planBase(command),
      query_only: true,
      requests: [
        { method: 'GET', path: '/review.json', query: { status: 'pending', offset: command.page * 10 } },
      ],
      require_queue_origin_for_mutation: true,
    };
  }

  if (command.operation === 'notifications_read') {
    validateReadCommand(command);
    return {
      ...planBase(command),
      query_only: true,
      requests: [
        {
          method: 'GET',
          path: '/notifications.json',
          query: { recent: true, silent: true, limit: Math.min(60, (command.page + 1) * 15) },
        },
      ],
      notification_seen_state_mutation_allowed: false,
    };
  }

  if (command.operation === 'outbound_inventory') {
    assertExactKeys(
      command,
      new Set(['schema_version', 'command_id', 'task_revision', 'instance_ref', 'operation']),
      'command',
    );
    return {
      ...planBase(command),
      query_only: true,
      requests: [],
      required_default_off: REQUIRED_OUTBOUND_POLICY,
      hidden_outbound_inventory: [
        'post/reply/mention/quote watcher notifications',
        'review approval notification and queued follow-on jobs',
        'welcome and trust-level promotion private messages',
        'invitation and account lifecycle email',
        'scheduled digest email',
        'desktop/mobile push',
        'group SMTP and plugin-defined callbacks',
      ],
      native_defaults_are_not_safe_for_isolation: true,
    };
  }

  if (command.operation === 'review_action') {
    assertExactKeys(
      command,
      new Set([
        'schema_version',
        'command_id',
        'task_revision',
        'instance_ref',
        'operation',
        'reviewable_id',
        'reviewable_version',
        'action_id',
        'prepared_by_ref',
        'reviewer_ref',
        'outbound_policy',
        'approval',
      ]),
      'command',
    );
    assertPositiveInteger(command.reviewable_id, 'reviewable_id');
    assertNonNegativeInteger(command.reviewable_version, 'reviewable_version');
    if (!SAFE_REVIEW_ACTIONS.has(command.action_id)) {
      fail('action_id must be approve_post or reject_post; direct post creation and messaging are excluded');
    }
    assertNonEmptyString(command.prepared_by_ref, 'prepared_by_ref');
    assertNonEmptyString(command.reviewer_ref, 'reviewer_ref');
    if (command.prepared_by_ref === command.reviewer_ref) {
      fail('reviewer_ref must differ from prepared_by_ref');
    }
    validateOutboundPolicy(command.outbound_policy);
    validateReviewApproval(command, now);

    const reviewPath = `/review/${command.reviewable_id}.json`;
    return {
      ...planBase(command),
      queue_only: true,
      staff_direct_post_allowed: false,
      independent_reviewer_verified: true,
      precondition_read: {
        method: 'GET',
        path: reviewPath,
        require: {
          id: command.reviewable_id,
          version: command.reviewable_version,
          status: 'pending',
          action_available: command.action_id,
          claimed_by_reviewer_or_unclaimed: true,
        },
      },
      requests: [
        {
          method: 'PUT',
          path: `/review/${command.reviewable_id}/perform/${command.action_id}.json`,
          body: { version: command.reviewable_version },
        },
      ],
      verification: {
        method: 'GET',
        path: reviewPath,
        require_status: command.action_id === 'approve_post' ? 'approved' : 'rejected',
        approved_post_readback:
          command.action_id === 'approve_post'
            ? { use_created_post_id_from_response: true, method: 'GET', path_template: '/posts/{id}.json' }
            : null,
      },
      expected_native_side_effects:
        command.action_id === 'approve_post'
          ? ['post creation', 'review transition events', 'in-app approval notification', 'queued post jobs']
          : ['review rejection event', 'staff action log when performed by staff'],
      external_notification_controls: command.outbound_policy,
      plugin_outbound_review_required: true,
    };
  }

  fail(`unsupported operation: ${String(command.operation)}`);
}

function normalizedHeaders(headers) {
  assertObject(headers, 'headers');
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readbackFor(eventType, resource) {
  if (eventType === 'topic') return { method: 'GET', path: `/t/${resource.id}.json` };
  if (eventType === 'post') return { method: 'GET', path: `/posts/${resource.id}.json` };
  if (eventType === 'reviewable') return { method: 'GET', path: `/review/${resource.id}.json` };
  return { method: 'GET', path: '/notifications.json', query: { recent: true, silent: true } };
}

export function verifyWebhook(envelope, secret) {
  assertObject(envelope, 'webhook envelope');
  assertExactKeys(
    envelope,
    new Set(['schema_version', 'expected_instance', 'headers', 'raw_body']),
    'webhook envelope',
  );
  if (envelope.schema_version !== WEBHOOK_SCHEMA) fail(`schema_version must equal ${WEBHOOK_SCHEMA}`);
  assertNonEmptyString(envelope.expected_instance, 'expected_instance');
  assertNonEmptyString(envelope.raw_body, 'raw_body');
  assertNonEmptyString(secret, 'webhook secret');

  const headers = normalizedHeaders(envelope.headers);
  const instance = headers['x-discourse-instance'];
  const eventId = headers['x-discourse-event-id'];
  const eventType = headers['x-discourse-event-type'];
  const eventName = headers['x-discourse-event'];
  const signature = headers['x-discourse-event-signature'];
  if (instance !== envelope.expected_instance) fail('webhook instance does not match expected_instance');
  assertNonEmptyString(eventId, 'x-discourse-event-id');
  if (!SAFE_WEBHOOK_TYPES.has(eventType)) fail(`unsupported webhook event type: ${String(eventType)}`);
  assertNonEmptyString(eventName, 'x-discourse-event');

  const expectedSignature = `sha256=${createHmac('sha256', secret).update(envelope.raw_body).digest('hex')}`;
  if (typeof signature !== 'string' || !secureEqual(signature, expectedSignature)) {
    fail('webhook signature is invalid');
  }

  const payload = JSON.parse(envelope.raw_body);
  assertObject(payload, 'Discourse webhook payload');
  const resource = payload[eventType];
  assertObject(resource, `Discourse webhook payload.${eventType}`);
  assertPositiveInteger(resource.id, `Discourse webhook payload.${eventType}.id`);
  const bodyHash = sha256(envelope.raw_body);
  const revision = resource.version ?? resource.updated_at ?? resource.post_number ?? '';

  return {
    schema_version: 'foundry.huaxiaobao.discourse.webhook-verification.v1',
    authenticated: true,
    event_id: eventId,
    event_type: eventType,
    event_name: eventName,
    body_sha256: bodyHash,
    deduplication_key: sha256(
      [instance, eventType, eventName, resource.id, revision, bodyHash].join('\u0000'),
    ),
    transport_ack_only: true,
    readback: readbackFor(eventType, resource),
  };
}

async function main() {
  const [option, filePath, ...extra] = process.argv.slice(2);
  if (!option || !filePath || extra.length > 0) {
    fail('usage: node script/foundry_huaxiaobao_contract.mjs --plan COMMAND.json | --verify-webhook EVENT.json');
  }
  const input = JSON.parse(await readFile(filePath, 'utf8'));
  if (option === '--plan') {
    process.stdout.write(`${JSON.stringify(buildPlan(input), null, 2)}\n`);
    return;
  }
  if (option === '--verify-webhook') {
    const secret = process.env.DISCOURSE_WEBHOOK_SECRET;
    if (!secret) fail('DISCOURSE_WEBHOOK_SECRET is required for webhook verification');
    process.stdout.write(`${JSON.stringify(verifyWebhook(input, secret), null, 2)}\n`);
    return;
  }
  fail(`unsupported option: ${option}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`contract validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
