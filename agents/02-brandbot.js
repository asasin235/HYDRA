import cron from 'node-cron';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { validateEnv } from '../core/validate-env.js';
import Agent from '../core/agent.js';
import { writeBrain, readBrain } from '../core/filesystem.js';

validateEnv('02-brandbot');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = '#02-brandbot';
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const BRAIN_PATH = process.env.BRAIN_PATH || './brain';
const MERCENARY_LEADS_FILE = path.join(BRAIN_PATH, 'brain', '10_MERCENARY', 'leads_inbox.json');

const brand = new Agent({
  name: '02-brandbot',
  model: 'mistral/mistral-small-latest',
  systemPromptPath: 'prompts/02-brandbot.txt',
  tools: [],
  namespace: '02_BRAND',
  tokenBudget: 150000
});

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', { channel: SLACK_CHANNEL, text }, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  } catch (e) {
    console.error('[02-brandbot] Slack post error:', e.message);
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function checkGithubActivity() {
  try {
    if (!GITHUB_USERNAME) return { merged_prs: [], new_repos: [], stars: [] };
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    const since = new Date(Date.now() - 7 * 86400000).toISOString();

    // Merged PRs via events
    const eventsRes = await axios.get(`https://api.github.com/users/${GITHUB_USERNAME}/events?per_page=50`, { headers });
    const events = eventsRes.data || [];
    const merged_prs = events
      .filter(e => e.type === 'PullRequestEvent' && e.payload?.action === 'closed' && e.payload?.pull_request?.merged)
      .map(e => ({ repo: e.repo?.name, title: e.payload.pull_request.title, merged_at: e.payload.pull_request.merged_at }))
      .filter(pr => pr.merged_at > since);

    // New repos
    const reposRes = await axios.get(`https://api.github.com/users/${GITHUB_USERNAME}/repos?sort=created&per_page=10`, { headers });
    const new_repos = (reposRes.data || [])
      .filter(r => r.created_at > since)
      .map(r => ({ name: r.name, description: r.description, url: r.html_url }));

    // Stars given
    const starsRes = await axios.get(`https://api.github.com/users/${GITHUB_USERNAME}/starred?per_page=5`, { headers });
    const stars = (starsRes.data || []).map(r => r.full_name);

    return { merged_prs, new_repos, stars };
  } catch (e) {
    console.error('[02-brandbot] checkGithubActivity error:', e.message);
    return { merged_prs: [], new_repos: [], stars: [] };
  }
}

async function draftLinkedinPost(activity) {
  const activityStr = typeof activity === 'object' ? JSON.stringify(activity, null, 2) : activity;
  const prompt = `Write an authentic 150-word LinkedIn post about a recent technical achievement. 
Rules:
- No hashtag spam (max 2 hashtags)
- Never start with "Excited to share" or "Thrilled to announce"
- No AI-sounding openers
- Write in first person, conversational tone
- Focus on the problem solved, not the technology used
- Include one specific metric or outcome if available`;
  return await brand.run(prompt, `GitHub activity this week:\n${activityStr}`);
}

async function checkLinkedinDms() {
  try {
    const dmsFile = path.join(BRAIN_PATH, 'brain', '02_BRAND', 'linkedin_dms.json');
    const exists = await fs.pathExists(dmsFile);
    if (!exists) return [];
    const dms = await fs.readJson(dmsFile);
    if (!Array.isArray(dms)) return [];

    const qualified = [];
    for (const dm of dms) {
      const text = (dm.message || '').toLowerCase();
      const isLead = /(hire|project|freelance|contract|work with|budget|quote|proposal|rate|opportunity)/i.test(text);
      if (isLead) {
        qualified.push({
          source: 'linkedin_dm',
          client: dm.from || 'unknown',
          status: 'new',
          budget: dm.budget || 'unspecified',
          message: dm.message?.slice(0, 300),
          received_at: dm.received_at || new Date().toISOString()
        });
      }
    }

    // Write qualified leads to mercenary inbox
    if (qualified.length > 0) {
      await fs.ensureDir(path.dirname(MERCENARY_LEADS_FILE));
      const existing = (await fs.pathExists(MERCENARY_LEADS_FILE))
        ? await fs.readJson(MERCENARY_LEADS_FILE)
        : [];
      await fs.writeJson(MERCENARY_LEADS_FILE, [...existing, ...qualified], { spaces: 2 });
    }
    return qualified;
  } catch (e) {
    console.error('[02-brandbot] checkLinkedinDms error:', e.message);
    return [];
  }
}

// ── Cron ─────────────────────────────────────────────────────────────────────

// Monday 10AM: draft 2 LinkedIn posts
cron.schedule('0 10 * * 1', async () => {
  try {
    const activity = await checkGithubActivity();
    const leads = await checkLinkedinDms();

    const post1 = await draftLinkedinPost(activity);
    const post2 = await brand.run(
      'Write a second 150-word LinkedIn post from a different angle — leadership, lessons learned, or team insight. Same rules: no hashtag spam, no AI openers.',
      `GitHub activity:\n${JSON.stringify(activity, null, 2)}`
    );

    let msg = `*LinkedIn Drafts for Approval*\n\n*Post 1:*\n${post1}\n\n*Post 2:*\n${post2}`;
    if (leads.length > 0) {
      msg += `\n\n*${leads.length} new lead(s) sent to 10-mercenary inbox.*`;
    }
    await postSlack(msg);
  } catch (e) {
    console.error('[02-brandbot] Monday post drafting failed:', e.message);
  }
}, { timezone: process.env.TZ || 'Asia/Kolkata' });

export { checkGithubActivity, draftLinkedinPost, checkLinkedinDms };

if (process.argv.includes('--draft-now')) {
  checkGithubActivity().then(activity => draftLinkedinPost(activity)).then(console.log);
}
