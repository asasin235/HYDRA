/**
 * scripts/audio-tagger.js — Keyword-based tagging and routing for audio transcripts
 *
 * Scans a transcript for specific keywords to assign logical tags,
 * then maps those tags to the HYDRA agents that should be interested.
 */

// Keyword → tag mapping
const TAG_RULES = {
  health: ['health', 'doctor', 'hospital', 'medicine', 'workout', 'gym', 'sleep', 'hrv', 'heart rate', 'steps', 'calories', 'diet', 'fasting'],
  finance: ['payment', 'credit', 'debit', 'salary', 'emi', 'loan', 'invest', 'rupee', '₹', 'budget', 'spend', 'stock', 'nifty', 'portfolio'],
  work: ['sprint', 'standup', 'jira', 'deploy', 'pr', 'code review', 'pipeline', 'production', 'client call', 'bug', 'ticket', 'feature', 'github', 'edmo'],
  relationship: ['sabiha', 'relationship', 'date', 'wedding', 'anniversary', 'gifts'],
  meeting: ['meeting', 'standup', 'sync', 'call', 'discussion', 'agenda', 'minutes', 'action items', 'catchup']
};

// Tag → agent routing
const TAG_AGENTS = {
  health: ['07-biobot'],
  finance: ['06-cfobot'],
  work: ['01-edmobot', '00-architect'],
  relationship: ['03-sahibabot'],
  meeting: ['00-architect']
};

/**
 * Detect tags from a transcript string
 * @param {string} transcript 
 * @returns {{ tags: string[], agents: string[] }}
 */
export function detectTags(transcript) {
  if (!transcript) return { tags: [], agents: [] };

  const lower = transcript.toLowerCase();
  const tags = new Set();
  const agents = new Set();

  for (const [tag, keywords] of Object.entries(TAG_RULES)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        tags.add(tag);

        // Add mapped agents
        const mappedAgents = TAG_AGENTS[tag] || [];
        for (const agent of mappedAgents) {
          agents.add(agent);
        }
        break; // stop checking keywords for this tag once it matches
      }
    }
  }

  return {
    tags: Array.from(tags),
    agents: Array.from(agents)
  };
}

/**
 * Build the YAML frontmatter string
 * @param {Object} metadata 
 * @param {string} metadata.source - e.g 'plaud-note'
 * @param {string} metadata.file - original filename
 * @param {string[]} metadata.tags 
 * @param {string[]} metadata.agents 
 * @param {string} metadata.date - YYYY-MM-DD
 * @returns {string} The YAML frontmatter block
 */
export function buildYAMLFrontmatter({ source, file, tags, agents, date }) {
  const tagsStr = tags.length > 0 ? `[${tags.join(', ')}]` : '[]';
  const agentsStr = agents.length > 0 ? `[${agents.join(', ')}]` : '[]';

  return `---
source: ${source}
file: ${file}
tags: ${tagsStr}
agents: ${agentsStr}
date: ${date}
---\n\n`;
}

/**
 * Helper to wrap a markdown string with the frontmatter metadata
 * @param {string} markdown 
 * @param {Object} metadata 
 * @returns {string} 
 */
export function wrapWithFrontmatter(markdown, metadata) {
  const frontmatter = buildYAMLFrontmatter(metadata);
  return frontmatter + markdown;
}
