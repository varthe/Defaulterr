# Audiochangerr

Automatically prevents Plex audio transcoding by switching to compatible streams.

## Features

- Auto-detects transcode sessions (webhook or polling)
- Rule-based audio stream selection
- Multi-user support (owner + managed users)
- Dry run mode for testing
- Keyword filtering (exclude commentary, etc.)

## Installation

```bash
git clone https://github.com/yourusername/audiochangerr.git
cd audiochangerr
npm install
```

**Requirements:**
- Node.js v14+
- Plex Media Server admin access
- Plex auth token

## Modes

| Mode | Response | Requirements | Setup |
|------|----------|--------------|-------|
| **Webhook** (default) | Instant | Plex Pass | Port forwarding |
| **Polling** | 10s delay | None | None |

## Configuration

Edit `config.yaml` to configure Audiochangerr:

```yaml
plex_server_url: "http://your-plex-server:32400"
plex_token: "YOUR_PLEX_TOKEN"
owner_username: "YOUR_PLEX_USERNAME"
check_interval: 10  # seconds between session checks (polling mode only)
dry_run: true       # set to false to enable actual changes

# Mode: "webhook" (requires Plex Pass) or "polling" (legacy mode)
mode: "webhook"
webhook_port: 3000

audio_selector:
  - codec: "ac3"
    channels: 6
    language: "original"
    keywords_exclude: ["Commentary", "commentary"]
  - codec: "ac3"
    channels: 2
    language: "original"
    keywords_exclude: ["Commentary", "commentary"]
  - codec: "aac"
    channels: 6
    language: "original"
    keywords_exclude: ["Commentary", "commentary"]
  - codec: "aac"
    channels: 2
    language: "original"
    keywords_exclude: ["Commentary", "commentary"]
```

**Required:**
- `plex_server_url` - Plex server URL
- `plex_token` - [Authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)
- `owner_username` - Plex username

**Mode settings:**
- `mode` - `"webhook"` or `"polling"`
- `webhook_port` - HTTP port (webhook mode)
- `check_interval` - Poll frequency in seconds (polling mode)

**Audio selector** - Rules processed top to bottom, first match wins:
- `codec` - Audio codec (`ac3`, `aac`, `dts`)
- `channels` - Minimum channels (6 = 5.1, 2 = stereo)
- `language` - Language code or `"original"`
- `keywords_include` - Required keywords in stream title
- `keywords_exclude` - Excluded keywords (takes precedence)

## Webhook Setup

**Start server:**
```bash
npm start
```

**Configure Plex:**
1. Plex Web App → Account → Webhooks → Add Webhook
2. URL: `http://YOUR_SERVER_IP:3000/webhook`

**Test:**
- Play media in Plex
- Check logs for `Webhook received: media.play`
- Visit `http://localhost:3000/health`

**Network:**
- Open port 3000 in firewall
- Same machine: use `localhost`
- Remote: may need port forwarding

## Usage

```bash
npm start  # Test with dry_run: true first
```

When ready: set `dry_run: false` in config.yaml

**Process:**
1. Detects transcode sessions
2. Finds compatible audio stream (via rules)
3. Switches audio stream
4. Terminates session (user restarts playback)
5. Validates direct play

## Troubleshooting

**Not detecting transcodes:**
- Verify `plex_server_url` and `plex_token`
- Check Plex Web shows active transcode
- Review logs for API errors

**Audio not switching:**
- Set `dry_run: false`
- Verify rules match available streams
- Check logs for rule matching

**Managed users not working:**
- Check logs for token fetch errors

**Webhooks not received:**
- Verify Plex Pass active
- Check webhook configured in Plex Web App
- Verify firewall allows webhook port
- Visit `http://localhost:3000/health`

## Testing

Run unit tests:
```bash
node test-webhook.js
```

## Contributing

Issues and pull requests welcome.

## License

Provided as-is. Comply with Plex terms of service.
