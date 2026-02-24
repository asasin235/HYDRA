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
    // Gateway
    app('99-slack-gateway'),
    // Scripts (data pipelines)
    script('ingest-audio', './scripts/ingest-audio.js'),
    script('plaud-sync', './scripts/plaud-sync.js'),
    script('screenpipe-sync', './scripts/screenpipe-sync.js'),
    script('hydra-mcp', './mcp/hydra-mcp-server.js'),
  ],
  // Custom groups for convenience
  deploy: {},
  // PM2 doesn't have native "groups"; use --only with app names
};

function app(name) {
  return {
    name,
    script: `./agents/${name}.js`,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production'
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
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production'
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
