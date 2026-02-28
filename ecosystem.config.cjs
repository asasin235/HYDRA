// Pre-load .env so NEW_RELIC_LICENSE_KEY is available in process.env
// when PM2 evaluates the env blocks below (before --require hooks run)
require('dotenv').config({ path: './.env' });

module.exports = {
  apps: [
    // Core agents
    app('00-architect'),
    app('01-edmobot'),
    app('02-brandbot'),
    app('03-sahibabot'),
    app('04-socialbot'),
    app('05-jarvis'),
    app('06-cfobot'),
    app('07-biobot'),
    app('09-wolf'),
    app('10-mercenary'),
    app('11-auditor'),
    app('12-careerbot'),
    // Gateway
    app('99-slack-gateway'),
    // Scripts (data pipelines)
    script('ingest-audio', './scripts/ingest-audio.js'),
    script('plaud-sync', './scripts/plaud-sync.js'),
    script('sms-reader', './scripts/sms-reader.js'),
    script('screenpipe-sync', './scripts/screenpipe-sync.js'),
    script('ingest-context', './scripts/ingest-context.js'),
    script('dashboard', './scripts/dashboard.js'),
    {
      name: 'backup',
      script: './scripts/backup-gdrive.sh',
      cron_restart: '0 2 * * *', // Run at 2 AM daily
      autorestart: false,
      error_file: './logs/backup.log',
      out_file: './logs/backup.log',
      time: true
    },
    // ── Observability ───────────────────────────────────────────────────────
    script('health-server', './core/health-server.js'),
    app('08-watchtower'),
    {
      name: 'pm2-exporter',
      script: './node_modules/pm2-prometheus-exporter/exporter.js',
      interpreter: '/opt/homebrew/bin/node',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
      },
      error_file: './logs/pm2-exporter.log',
      out_file: './logs/pm2-exporter.log',
      time: true
    },
    // NOTE: hydra-mcp is NOT managed by PM2. It uses stdio transport and is
    // spawned on-demand by OpenClaw via: openclaw mcp add --name hydra --command "node mcp/hydra-mcp-server.js"
    //
    // NOTE: Hermes Agent Gateway is managed independently (not PM2):
    //   hermes gateway install   → installs as macOS launchd service
    //   hermes gateway start     → start
    //   hermes gateway stop      → stop
    //   hermes gateway status    → check
    // Hermes handles: WhatsApp, Telegram, Discord, Slack bridges
  ],
  // Custom groups for convenience
  deploy: {},
  // PM2 doesn't have native "groups"; use --only with app names
};

function app(name) {
  return {
    name,
    script: `./agents/${name}.js`,
    interpreter: '/opt/homebrew/bin/node',
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '512M',
    node_args: '--require newrelic --require dotenv/config',
    env: {
      NODE_ENV: 'production',
      DOTENV_CONFIG_PATH: './.env',
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      NEW_RELIC_APP_NAME: `HYDRA/${name}`,
      NEW_RELIC_LICENSE_KEY: process.env.NEW_RELIC_LICENSE_KEY || '',
      LANCEDB_LOG: process.env.LANCEDB_LOG || 'debug',
    },
    error_file: `./logs/${name}.log`,
    out_file: `./logs/${name}.log`,
    time: true
  };
}

function script(name, scriptPath) {
  return {
    name,
    script: scriptPath,
    interpreter: '/opt/homebrew/bin/node',
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '256M',
    node_args: '--require newrelic --require dotenv/config',
    env: {
      NODE_ENV: 'production',
      DOTENV_CONFIG_PATH: './.env',
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      NEW_RELIC_APP_NAME: `HYDRA/${name}`,
      NEW_RELIC_LICENSE_KEY: process.env.NEW_RELIC_LICENSE_KEY || '',
      LANCEDB_LOG: process.env.LANCEDB_LOG || 'debug',
    },
    error_file: `./logs/${name}.log`,
    out_file: `./logs/${name}.log`,
    time: true
  };
}

/*
Start all apps:
  pm2 start ecosystem.config.cjs

Start MVP subset for Day 1 testing:
  pm2 start ecosystem.config.cjs --only 00-architect,06-cfobot,05-jarvis,99-slack-gateway

Start data pipelines only:
  pm2 start ecosystem.config.cjs --only ingest-audio,screenpipe-sync
*/
