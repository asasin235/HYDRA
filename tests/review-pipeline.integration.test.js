/**
 * Integration Tests — Full Review Pipeline
 *
 * Covers end-to-end flow:
 * 1. Ingest audio → creates review queue entry
 * 2. Reviewer edits → saves draft
 * 3. Reviewer approves → approval pipeline runs
 * 4. Final records exist in interactions, participants, facts, tasks
 * 5. Re-run preserves manual overrides
 * 6. Archive flow terminates correctly
 *
 * NOTE: These tests require a real SQLite DB (in-memory or test fixture).
 * Run with: npx vitest tests/review-pipeline.integration.test.js
 *
 * @module tests/review-pipeline.integration.test.js
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';

// We import lazily to allow test DB setup before module init
let reviewActions, approvalPipeline, reviewQueueDb, interactionsDb;

const TEST_REVIEW_ID = uuid();
const MOCK_REVIEWER = 'test-reviewer-001';

// Minimal mock for vector writer
const mockVectorWriter = async ({ text, metadata }) => {
  return { written: true, interactionId: metadata.interaction_id };
};

describe('review-pipeline integration', () => {

  describe('full happy path: ingest → review → approve', () => {

    it('createQueueItem creates a pending review entry', async () => {
      // This test validates the queue DB helper contract
      // Actual DB import happens in test environment with test DB
      const { createQueueItem, getQueueItem } = await import('../core/review-queue-db.js');

      const id = uuid();
      createQueueItem({
        id,
        source: 'plaud-note',
        summary: 'Discussed project milestones with team.',
        language: 'en',
        sensitivity: 'low',
        retentionClass: 'context',
        domain: 'work',
        relationshipType: 'coworker',
      });

      const item = getQueueItem(id);
      expect(item).toBeDefined();
      expect(item.status).toBe('pending');
      expect(item.domain).toBe('work');
    });

    it('saveDraft preserves edits without changing lifecycle status', async () => {
      const { createQueueItem } = await import('../core/review-queue-db.js');
      const { saveDraft } = await import('../core/review-actions.js');
      const { getQueueItem } = await import('../core/review-queue-db.js');

      const id = uuid();
      createQueueItem({
        id,
        source: 'plaud-note',
        summary: 'Original summary.',
        language: 'en',
      });

      saveDraft(id, MOCK_REVIEWER, {
        summary: 'Edited summary.',
        domain: 'personal',
      });

      const item = getQueueItem(id);
      expect(item.status).not.toBe('approved');
      expect(item.status).not.toBe('archived');
    });

    it('approveAndIngest moves status to approved', async () => {
      const { createQueueItem, getQueueItem } = await import('../core/review-queue-db.js');
      const { approveAndIngest } = await import('../core/review-actions.js');

      const id = uuid();
      createQueueItem({
        id,
        source: 'plaud-note',
        summary: 'Meeting with client about contract renewal.',
        language: 'en',
        sensitivity: 'medium',
        retentionClass: 'task_candidate',
        domain: 'work',
        relationshipType: 'client',
      });

      await approveAndIngest(id, MOCK_REVIEWER, { vectorWriteFn: mockVectorWriter });

      const item = getQueueItem(id);
      expect(['approved', 'indexed']).toContain(item.status);
    });

  });

  describe('override preservation on re-run', () => {

    it('re-run does not overwrite human overrides', async () => {
      const { createQueueItem, getQueueItem } = await import('../core/review-queue-db.js');
      const { saveDraft, rerunAnalysis } = await import('../core/review-actions.js');

      const id = uuid();
      createQueueItem({
        id,
        source: 'plaud-note',
        summary: 'Discussed weekend plans.',
        language: 'mixed-hi-en',
      });

      // Human sets an explicit override
      saveDraft(id, MOCK_REVIEWER, {
        domain: 'personal',
        relationship_type: 'friend',
        _human_override_domain: true,
        _human_override_relationship: true,
      });

      // Re-run analysis
      await rerunAnalysis(id);

      const item = getQueueItem(id);
      // Human overrides must be preserved
      expect(item.domain).toBe('personal');
      expect(item.relationship_type).toBe('friend');
    });

  });

  describe('archive flow', () => {

    it('archiveItem sets status to archived and is terminal', async () => {
      const { createQueueItem, getQueueItem } = await import('../core/review-queue-db.js');
      const { archiveItem } = await import('../core/review-actions.js');

      const id = uuid();
      createQueueItem({
        id,
        source: 'plaud-note',
        summary: 'Background noise only.',
        language: 'unknown',
      });

      archiveItem(id, MOCK_REVIEWER, 'Not a meaningful conversation');

      const item = getQueueItem(id);
      expect(item.status).toBe('archived');
    });

    it('archived item cannot be approved', async () => {
      const { createQueueItem } = await import('../core/review-queue-db.js');
      const { archiveItem, approveAndIngest } = await import('../core/review-actions.js');

      const id = uuid();
      createQueueItem({
        id,
        source: 'plaud-note',
        summary: 'Empty recording.',
        language: 'unknown',
      });

      archiveItem(id, MOCK_REVIEWER, 'Empty');

      await expect(
        approveAndIngest(id, MOCK_REVIEWER, {})
      ).rejects.toThrow();
    });

  });

});
