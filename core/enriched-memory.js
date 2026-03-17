/**
 * Enriched Memory — writes conversation data to vector memory with
 * full reviewed social metadata attached.
 *
 * Enriched entries include: language, domain, relationship, participants,
 * sensitivity, retention class, and source id — enabling safe scoped retrieval.
 *
 * @module core/enriched-memory
 */
import { createLogger } from './logger.js';

const log = createLogger('enriched-memory');

/**
 * Build enriched metadata payload for a vector memory entry.
 * @param {object} params
 * @returns {object} metadata object ready for vector store
 */
export function buildEnrichedMetadata({
  interactionId,
  reviewQueueId,
  language = 'unknown',
  domain = 'unknown',
  relationship = 'unknown',
  participants = [],
  sensitivity = 'low',
  retentionClass = 'context',
  source = 'plaud-note',
  factCount = 0,
  taskCount = 0,
  approvedAt = null,
} = {}) {
  return {
    interaction_id: interactionId,
    review_queue_id: reviewQueueId,
    language,
    domain,
    relationship,
    participants: Array.isArray(participants) ? participants : [],
    participant_count: Array.isArray(participants) ? participants.length : 0,
    sensitivity,
    retention_class: retentionClass,
    source,
    fact_count: factCount,
    task_count: taskCount,
    approved_at: approvedAt || new Date().toISOString(),
    is_restricted: sensitivity === 'restricted' || sensitivity === 'high',
    is_ephemeral: retentionClass === 'ephemeral',
  };
}

/**
 * Write an enriched entry to vector memory.
 * Accepts a memory writer function for dependency injection
 * (e.g., LanceDB or RuVector writer).
 *
 * @param {object} params
 * @param {string} params.text - the normalized summary text to embed
 * @param {string} [params.rawTranscript] - raw transcript (stored but not embedded by default)
 * @param {object} params.metadata - enriched metadata from buildEnrichedMetadata
 * @param {Function} params.writerFn - async fn({ text, metadata }) that writes to vector store
 * @returns {Promise<object>} write result
 */
export async function writeEnrichedMemory({ text, rawTranscript, metadata, writerFn }) {
  if (!text && !rawTranscript) {
    throw new Error('Either text or rawTranscript must be provided');
  }
  if (typeof writerFn !== 'function') {
    throw new Error('writerFn is required — inject vector store writer');
  }

  // Embed the normalized summary, not the raw transcript
  const embeddingText = text || rawTranscript;

  const payload = {
    text: embeddingText,
    raw_transcript: rawTranscript || null,
    metadata: {
      ...metadata,
      embedded_text_type: text ? 'normalized_summary' : 'raw_transcript',
    },
  };

  try {
    const result = await writerFn(payload);
    log.info(
      { interactionId: metadata.interaction_id, domain: metadata.domain },
      'Enriched vector memory written'
    );
    return { success: true, interactionId: metadata.interaction_id, ...result };
  } catch (err) {
    log.error(
      { interactionId: metadata.interaction_id, error: err.message },
      'Enriched vector memory write failed'
    );
    throw err;
  }
}

/**
 * Build metadata and write in one step (convenience wrapper).
 */
export async function enrichAndWrite({ text, rawTranscript, writerFn, ...metadataParams }) {
  const metadata = buildEnrichedMetadata(metadataParams);
  return writeEnrichedMemory({ text, rawTranscript, metadata, writerFn });
}

/**
 * Validate that a metadata object has all required enrichment fields.
 * Returns list of missing fields.
 */
export function validateEnrichment(metadata) {
  const required = ['interaction_id', 'language', 'domain', 'relationship', 'sensitivity', 'retention_class'];
  const missing = required.filter(k => !metadata[k] || metadata[k] === undefined);
  return { valid: missing.length === 0, missing };
}
