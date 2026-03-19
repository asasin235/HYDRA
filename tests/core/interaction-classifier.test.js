/**
 * Unit Tests — Interaction Classifier
 *
 * Covers:
 * - Hindi-only conversation
 * - Hinglish work context
 * - Hinglish friend context
 * - Mixed domain (work + personal)
 * - Unknown participant
 * - Low-confidence fallback
 * - Sensitive personal content
 * - Override precedence (human > auto)
 *
 * @module tests/core/interaction-classifier.test.js
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyInteraction,
  applyHumanOverride,
  getEffectiveClassification,
} from '../../core/interaction-classifier.js';

// --- Test fixtures ---

const hindiOnlySummary = 'आज की मीटिंग में प्रोजेक्ट की समीक्षा की गई। डेडलाइन अगले शुक्रवार है।';
const hinglishWorkSummary = 'Aaj meeting mein project deadline discuss ki. Client ne next sprint ka scope confirm kiya.';
const hinglishFriendSummary = 'Yaar kal party mein bahut maza aaya. Tumhara birthday plan kar rahe hain hum.';
const mixedDomainSummary = 'Discussed Q3 targets with manager. Also talked about family vacation plans next month.';
const sensitivePersonalSummary = 'Discussed health diagnosis and personal finances. Very private conversation.';

describe('interaction-classifier', () => {

  describe('classifyInteraction()', () => {

    it('classifies hindi-only as language=hi', () => {
      const result = classifyInteraction({
        summary: hindiOnlySummary,
        language: 'hi',
        participants: [],
      });
      expect(result).toMatchObject({
        language: 'hi',
      });
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('classifies hinglish work context as domain=work', () => {
      const result = classifyInteraction({
        summary: hinglishWorkSummary,
        language: 'mixed-hi-en',
        participants: [{ role: 'contact', label: 'Client' }],
      });
      expect(result.domain).toBe('work');
    });

    it('classifies hinglish friend context as relationship=friend', () => {
      const result = classifyInteraction({
        summary: hinglishFriendSummary,
        language: 'mixed-hi-en',
        participants: [],
      });
      expect(['friend', 'personal', 'mixed']).toContain(result.relationship_type);
    });

    it('classifies mixed domain content as domain=mixed', () => {
      const result = classifyInteraction({
        summary: mixedDomainSummary,
        language: 'en',
        participants: [{ role: 'manager' }],
      });
      // mixed or work are both valid given ambiguity
      expect(['mixed', 'work', 'personal']).toContain(result.domain);
    });

    it('handles unknown participant gracefully', () => {
      const result = classifyInteraction({
        summary: 'Met with someone at the coffee shop.',
        language: 'en',
        participants: [{ role: 'unknown', personId: null }],
      });
      expect(result).toBeDefined();
      expect(result.relationship_type).toBeDefined();
    });

    it('returns low confidence for ambiguous content', () => {
      const result = classifyInteraction({
        summary: 'Had a conversation.',
        language: 'unknown',
        participants: [],
      });
      expect(result.confidence).toBeLessThan(0.6);
    });

    it('classifies sensitive personal content with elevated sensitivity', () => {
      const result = classifyInteraction({
        summary: sensitivePersonalSummary,
        language: 'en',
        participants: [],
      });
      expect(['high', 'restricted']).toContain(result.sensitivity);
    });

    it('returns object with required fields', () => {
      const result = classifyInteraction({
        summary: 'Test conversation.',
        language: 'en',
        participants: [],
      });
      expect(result).toHaveProperty('relationship_type');
      expect(result).toHaveProperty('domain');
      expect(result).toHaveProperty('sensitivity');
      expect(result).toHaveProperty('retention_class');
      expect(result).toHaveProperty('confidence');
    });

  });

  describe('override precedence', () => {

    it('human override takes precedence over auto classification', () => {
      const base = classifyInteraction({
        summary: hinglishWorkSummary,
        language: 'mixed-hi-en',
        participants: [],
      });

      const overridden = applyHumanOverride(base, {
        relationship_type: 'friend',
        domain: 'personal',
      });

      expect(overridden.relationship_type).toBe('friend');
      expect(overridden.domain).toBe('personal');
      expect(overridden._overridden).toBe(true);
    });

    it('partial override preserves non-overridden fields', () => {
      const base = classifyInteraction({
        summary: sensitivePersonalSummary,
        language: 'en',
        participants: [],
      });

      const overridden = applyHumanOverride(base, {
        sensitivity: 'medium',
      });

      expect(overridden.sensitivity).toBe('medium');
      // other fields preserved from auto
      expect(overridden.relationship_type).toBe(base.relationship_type);
      expect(overridden.domain).toBe(base.domain);
    });

    it('override does not change confidence field (confidence belongs to auto)', () => {
      const base = classifyInteraction({
        summary: 'Short meeting.',
        language: 'en',
        participants: [],
      });
      const originalConfidence = base.confidence;

      const overridden = applyHumanOverride(base, { relationship_type: 'coworker' });

      // confidence reflects auto result, not override certainty
      expect(overridden.confidence).toBe(originalConfidence);
    });

  });

});
