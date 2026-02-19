export function validateEnv() {
  const required = [
    'OPENROUTER_API_KEY',
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
    'SLACK_APP_TOKEN',
    'PI_SMB_PATH',
    'HOME_ASSISTANT_URL',
    'HOME_ASSISTANT_TOKEN',
    'DASHBOARD_TOKEN',
    'INTERNAL_API_KEY',
    'B2_ACCOUNT_ID',
    'B2_APP_KEY',
    'B2_BUCKET'
  ];

  const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
  for (const k of missing) {
    console.error(`❌ MISSING ENV: ${k}`);
  }
  if (missing.length) {
    throw new Error(`HYDRA startup failed: ${missing.length} env vars missing. Check .env file.`);
  }
}
