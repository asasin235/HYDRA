/**
 * Dashboard Metrics Routes — API endpoints for review pipeline metrics.
 *
 * Metrics: pending count, approved/archived today, avg review latency,
 * unresolved participants, unknown rate, restricted count, language mix,
 * retention distribution.
 *
 * @module scripts/dashboard-metrics-routes
 */
import { getDb } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('dashboard-metrics');

/**
 * Register metrics routes on the Express app.
 * @param {import('express').Express} app
 */
export function registerMetricsRoutes(app) {

  /**
   * GET /api/review/metrics — aggregate review pipeline metrics.
   */
  app.get('/api/review/metrics', (req, res) => {
    try {
      const db = getDb();
      const today = new Date().toISOString().split('T')[0];

      // Pending count
      const pending = db.prepare(
        "SELECT COUNT(*) as count FROM audio_review_queue WHERE status = 'pending'"
      ).get();

      // In review count
      const inReview = db.prepare(
        "SELECT COUNT(*) as count FROM audio_review_queue WHERE status = 'in_review'"
      ).get();

      // Approved today
      const approvedToday = db.prepare(
        "SELECT COUNT(*) as count FROM audio_review_queue WHERE status IN ('approved', 'indexed') AND updated_at >= ?"
      ).get(today);

      // Archived today
      const archivedToday = db.prepare(
        "SELECT COUNT(*) as count FROM audio_review_queue WHERE status = 'archived' AND updated_at >= ?"
      ).get(today);

      // Average review latency (hours) for items completed today
      const avgLatency = db.prepare(`
        SELECT AVG(
          (julianday(updated_at) - julianday(created_at)) * 24
        ) as avg_hours
        FROM audio_review_queue
        WHERE status IN ('approved', 'indexed', 'archived')
        AND updated_at >= ?
      `).get(today);

      // Unresolved participants (unknown person_id)
      let unresolvedParticipants = { count: 0 };
      try {
        unresolvedParticipants = db.prepare(
          "SELECT COUNT(*) as count FROM interaction_participants WHERE person_id IS NULL OR person_id = ''"
        ).get();
      } catch (_) { /* table may not exist yet */ }

      // Unknown classification rate
      let unknownRate = { count: 0, total: 0 };
      try {
        const unknown = db.prepare(
          "SELECT COUNT(*) as count FROM interactions WHERE relationship_type = 'unknown'"
        ).get();
        const total = db.prepare(
          "SELECT COUNT(*) as count FROM interactions"
        ).get();
        unknownRate = { count: unknown.count, total: total.count };
      } catch (_) { /* table may not exist yet */ }

      // Restricted count
      let restrictedCount = { count: 0 };
      try {
        restrictedCount = db.prepare(
          "SELECT COUNT(*) as count FROM interactions WHERE sensitivity = 'restricted'"
        ).get();
      } catch (_) {}

      // Language mix
      let languageMix = [];
      try {
        languageMix = db.prepare(
          "SELECT language, COUNT(*) as count FROM audio_review_queue GROUP BY language ORDER BY count DESC"
        ).all();
      } catch (_) {}

      // Retention distribution
      let retentionDist = [];
      try {
        retentionDist = db.prepare(
          "SELECT retention_class, COUNT(*) as count FROM interactions GROUP BY retention_class ORDER BY count DESC"
        ).all();
      } catch (_) {}

      const metrics = {
        pending: pending.count,
        inReview: inReview.count,
        approvedToday: approvedToday.count,
        archivedToday: archivedToday.count,
        avgReviewLatencyHours: avgLatency.avg_hours ? Math.round(avgLatency.avg_hours * 10) / 10 : null,
        unresolvedParticipants: unresolvedParticipants.count,
        unknownClassificationRate: unknownRate.total > 0
          ? Math.round((unknownRate.count / unknownRate.total) * 100)
          : 0,
        restrictedCount: restrictedCount.count,
        languageMix,
        retentionDistribution: retentionDist,
        generatedAt: new Date().toISOString(),
      };

      log.info({ metrics: { pending: metrics.pending, approved: metrics.approvedToday } }, 'Metrics generated');
      res.json(metrics);
    } catch (err) {
      log.error({ error: err.message }, 'Metrics generation failed');
      res.status(500).json({ error: 'Failed to generate metrics' });
    }
  });

  /**
   * GET /api/review/metrics/timeline — daily approve/archive counts for the past 30 days.
   */
  app.get('/api/review/metrics/timeline', (req, res) => {
    try {
      const db = getDb();
      const days = parseInt(req.query.days) || 30;

      const timeline = db.prepare(`
        SELECT
          date(updated_at) as day,
          SUM(CASE WHEN status IN ('approved', 'indexed') THEN 1 ELSE 0 END) as approved,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
        FROM audio_review_queue
        WHERE updated_at >= date('now', ?)
        GROUP BY date(updated_at)
        ORDER BY day ASC
      `).all(`-${days} days`);

      res.json({ days, timeline });
    } catch (err) {
      log.error({ error: err.message }, 'Timeline metrics failed');
      res.status(500).json({ error: 'Failed to generate timeline' });
    }
  });

  log.info('Review metrics routes registered');
}
