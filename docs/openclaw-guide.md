# OpenClaw + HYDRA — Setup & Usage Guide

> A step-by-step guide for HYDRA users to set up OpenClaw as the messaging I/O layer.

---

## What is OpenClaw?

[OpenClaw](https://docs.openclaw.ai) is a self-hosted, multi-channel AI gateway that gives HYDRA the ability to send and receive messages across **WhatsApp, iMessage, Discord, Telegram, Signal**, and more — all from a single gateway running on your Mac Mini.

### How HYDRA Uses It

```
WhatsApp / iMessage / Discord / Telegram
                │
                ▼
    ┌───────────────────────┐
    │   OpenClaw Gateway    │  (runs as a daemon on your Mac)
    │   ws://127.0.0.1:18789│
    └───────────┬───────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
  Incoming msgs    Outgoing msgs
  (hooks.onMessage)  (openclaw CLI)
        │               │
        ▼               ▼
  ┌──────────┐   ┌──────────────┐
  │ SocialBot│   │ Any HYDRA    │
  │ webhook  │   │ Agent via    │
  │ :3004    │   │ core/openclaw│
  └──────────┘   └──────────────┘
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **macOS** | OpenClaw iMessage integration requires macOS |
| **Node.js ≥ 22** | Same as HYDRA |
| **HYDRA installed** | With `npm install` completed |
| **A phone number** | For WhatsApp linking (your personal or a spare) |

---

## Part 1: Installing OpenClaw

### 1.1 Install the CLI

```bash
npm install -g openclaw@latest
```

Verify installation:

```bash
openclaw --version
# Expected: 🦞 OpenClaw 2026.x.x
```

### 1.2 Run the Onboarding Wizard

```bash
openclaw onboard
```

This interactive wizard will:
- Create the config directory (`~/.openclaw/`)
- Set up default agent workspace
- Configure your preferred AI model provider (optional — HYDRA uses its own LLMs via OpenRouter)

### 1.3 Install the Gateway Service

```bash
openclaw gateway install
```

This registers OpenClaw as a **launchd service** on macOS, so it auto-starts on boot.

---

## Part 2: Linking Channels

### WhatsApp (Primary)

```bash
openclaw channels login --channel whatsapp
```

This opens a QR code in your terminal. **Scan it with WhatsApp > Linked Devices > Link a Device** on your phone.

Verify the link:

```bash
openclaw channels status
```

You should see WhatsApp listed as **connected**.

### iMessage (macOS only)

```bash
openclaw channels login --channel imessage
```

> **Note:** iMessage integration uses macOS's native `imsg` CLI and requires Full Disk Access for Terminal/iTerm in System Preferences > Privacy & Security.

### Discord (Optional)

1. Create a Discord bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot settings
3. Copy the bot token
4. Add it to OpenClaw:

```bash
openclaw channels add --channel discord --token YOUR_BOT_TOKEN
```

### Telegram (Optional)

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram to create a bot
2. Copy the bot token
3. Add it to OpenClaw:

```bash
openclaw channels add --channel telegram --token YOUR_BOT_TOKEN
```

---

## Part 3: Connecting HYDRA to OpenClaw

### 3.1 Start the Gateway

```bash
openclaw gateway start
```

Verify it's running:

```bash
openclaw health
# Expected: JSON response with gateway health info
```

### 3.2 Configure the Incoming Message Webhook

HYDRA's SocialBot listens on port `3004` for incoming messages. Tell OpenClaw to forward messages there:

```bash
openclaw config set hooks.onMessage "http://127.0.0.1:3004/social/incoming"
```

### 3.3 Configure HYDRA's Environment

In your HYDRA `.env` file, ensure these are set:

```bash
# Path to openclaw binary (default: openclaw, found via PATH)
OPENCLAW_BIN=openclaw

# CLI timeout in ms (default: 15000)
OPENCLAW_TIMEOUT=15000

# SocialBot webhook port (must match the hooks.onMessage URL above)
SOCIAL_WEBHOOK_PORT=3004
```

### 3.4 Restrict Who Can Message (Recommended)

By default, OpenClaw accepts messages from everyone. Lock it down:

```bash
# Only allow specific contacts (use E.164 phone numbers)
openclaw config set channels.whatsapp.allowFrom '["+919876543210", "+919876543211"]'
```

Or require mentions in group chats:

```bash
openclaw config set channels.whatsapp.groups '{"*": {"requireMention": true}}'
openclaw config set messages.groupChat.mentionPatterns '["@hydra"]'
```

### 3.5 Start HYDRA

```bash
cd ~/Desktop/projects/HYDRA
npm start
# or for MVP subset:
npm run dev
```

---

## Part 4: Using OpenClaw with HYDRA

### Sending Messages (Any Agent)

Any HYDRA agent can send messages by importing from `core/openclaw.js`:

```javascript
import { sendWhatsApp, sendIMessage, sendDiscord } from '../core/openclaw.js';

// Send a WhatsApp message
await sendWhatsApp('+919876543210', 'Hello from HYDRA! 🐉');

// Send an iMessage
await sendIMessage('user@icloud.com', 'Reminder: meeting at 3pm');

// Send with media attachment
await sendWhatsApp('+919876543210', 'Check this out', {
  media: '/path/to/image.jpg'
});

// Dry-run (test without actually sending)
await sendWhatsApp('+919876543210', 'test message', { dryRun: true });
```

### Receiving Messages (SocialBot Flow)

1. Someone sends you a WhatsApp/iMessage message
2. OpenClaw forwards it to SocialBot's webhook (`http://127.0.0.1:3004/social/incoming`)
3. SocialBot drafts a reply using Claude Haiku with your personality prompt
4. Draft appears in Slack `#04-socialbot` with buttons:
   - **📤 Send Now** — sends the draft via OpenClaw
   - **✏️ Edit** — lets you modify the draft first
   - **🗑️ Discard** — drops the draft

### Via Slack Commands

```
@hydra sahibabot draft goodnight message
# → Drafts a WhatsApp message for Sabiha, posts to Slack with send/edit/discard buttons
```

### Reading Recent Messages

```javascript
import { getMessages } from '../core/openclaw.js';

// Get last 10 WhatsApp messages from a contact
const messages = await getMessages('whatsapp', '+919876543210', 10);
```

### Checking Gateway Health

```javascript
import { getGatewayStatus, getChannelStatus } from '../core/openclaw.js';

const health = await getGatewayStatus();
console.log(health.online); // true/false

const channels = await getChannelStatus();
console.log(channels); // channel connection details
```

---

## Part 5: Troubleshooting

### Gateway Not Starting

```bash
# Run diagnostics
openclaw doctor

# Auto-fix common issues
openclaw doctor --fix

# Check logs
openclaw logs
```

### WhatsApp Disconnects

WhatsApp Web sessions can expire. Re-link:

```bash
openclaw channels login --channel whatsapp
```

### Messages Not Arriving at SocialBot

1. Verify the webhook hook is set:
   ```bash
   openclaw config get hooks.onMessage
   # Should return: http://127.0.0.1:3004/social/incoming
   ```

2. Verify SocialBot is running:
   ```bash
   pm2 status 04-socialbot
   curl http://127.0.0.1:3004/social/health
   ```

3. Check if the contact is in the allowlist:
   ```bash
   openclaw config get channels.whatsapp.allowFrom
   ```

### Send Failures from HYDRA

```bash
# Test send manually via CLI
openclaw message send --channel whatsapp --target +919876543210 --message "test" --dry-run

# Check channel status
openclaw channels status --probe
```

---

## Quick Reference: CLI Commands

| Command | Description |
|---------|-------------|
| `openclaw health` | Check gateway health |
| `openclaw channels status` | Check channel connections |
| `openclaw channels login --channel whatsapp` | Link WhatsApp |
| `openclaw message send --channel whatsapp --target +91... --message "Hi"` | Send a message |
| `openclaw message send ... --dry-run` | Test send (no delivery) |
| `openclaw message read --channel whatsapp --target +91... --limit 5` | Read recent messages |
| `openclaw config set <key> <value>` | Update config |
| `openclaw config get <key>` | Read config |
| `openclaw doctor` | Diagnose issues |
| `openclaw gateway restart` | Restart gateway |
| `openclaw logs` | Tail gateway logs |

---

## Architecture Reference

For more details, see:
- [OpenClaw Docs](https://docs.openclaw.ai)
- [HYDRA README](./README.md)
- [OpenClaw Gateway Protocol](https://docs.openclaw.ai/gateway/protocol)
- [Multi-Agent Routing](https://docs.openclaw.ai/concepts/multi-agent)
