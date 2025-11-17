# Audiochangerr

**Audiochangerr** is an automated Plex companion tool that prevents audio transcoding by intelligently switching to compatible audio streams when transcoding is detected.

## Overview

When Plex transcodes your media due to audio codec incompatibility, it wastes server resources and can degrade playback quality. Audiochangerr monitors your Plex server for active transcode sessions and automatically switches to a compatible audio stream that won't require transcoding, helping you achieve direct play whenever possible.

## Features

- **Automatic Transcode Detection**: Continuously monitors active Plex sessions for audio transcoding
- **Intelligent Audio Selection**: Configurable rule-based system to select the best compatible audio stream
- **Multi-User Support**: Works with both server owner and managed user accounts
- **Session Management**: Automatically terminates problematic sessions and validates the restart
- **Dry Run Mode**: Test configuration without making actual changes
- **Flexible Audio Rules**: Prioritize audio streams by codec, channels, language, and keywords
- **Keyword Filtering**: Include or exclude audio tracks based on keywords (e.g., exclude commentary tracks)
- **Logging**: Detailed Winston-based logging for monitoring and troubleshooting

## Requirements

- Node.js (v14 or higher recommended)
- A Plex Media Server with admin access
- Plex authentication token

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/audiochangerr.git
   cd audiochangerr
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure the application (see Configuration section below)

## Operating Modes

Audiochangerr supports two modes of operation:

### Webhook Mode (Recommended)
- **Instant response** to playback events
- **Requires**: Active Plex Pass subscription
- **Pros**: Near-zero latency, minimal server load
- **Cons**: Requires network configuration (port forwarding/firewall)

### Polling Mode (Legacy)
- **Periodic checking** for transcode sessions
- **No special requirements**
- **Pros**: Simple setup, works without Plex Pass
- **Cons**: 10+ second delay, constant API polling

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

### Configuration Options

- **plex_server_url**: Your Plex server URL (e.g., `http://localhost:32400`)
- **plex_token**: Your Plex authentication token ([How to find your token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))
- **owner_username**: Your Plex username (account owner)
- **check_interval**: How often to check for active sessions (in seconds) - only used in polling mode
- **dry_run**: When `true`, logs actions without making changes (recommended for testing)
- **mode**: Operating mode - `"webhook"` or `"polling"`
- **webhook_port**: Port for webhook HTTP server (only used in webhook mode)

### Audio Selector Rules

Rules are processed **top to bottom**. The first matching stream is selected.

Each rule can specify:
- **codec**: Audio codec (`ac3`, `aac`, `dts`, etc.)
- **channels**: Minimum number of audio channels (e.g., `6` for 5.1, `2` for stereo)
- **language**: Language code (e.g., `eng`, `jpn`) or `original` to match the current stream's language
- **keywords_include** (optional): Stream title must contain at least one of these keywords
- **keywords_exclude** (optional): Stream title must NOT contain any of these keywords (takes precedence)

## Webhook Mode Setup

If using webhook mode (recommended for Plex Pass users), follow these additional steps:

### 1. Start Audiochangerr

```bash
npm start
```

You'll see output like:
```
[INFO]: Webhook server listening on port 3000
[INFO]: Configure Plex webhook URL: http://YOUR_SERVER_IP:3000/webhook
[INFO]: Health check available at: http://localhost:3000/health
```

### 2. Configure Plex Webhook

1. Open **Plex Web App** in your browser
2. Click your **user icon** (top right) → **Account**
3. Scroll down to **Webhooks** section
4. Click **Add Webhook**
5. Enter the URL: `http://YOUR_SERVER_IP:3000/webhook`
   - Replace `YOUR_SERVER_IP` with the IP address where Audiochangerr is running
   - If on the same machine as Plex: use `http://localhost:3000/webhook`
   - If on a different machine: use the actual IP address
6. Click **Save**

### 3. Test Webhook

1. Play any media in Plex
2. Check Audiochangerr logs for: `[INFO]: Webhook received: media.play`
3. Visit `http://localhost:3000/health` to verify webhooks are being received

### 4. Enable Live Mode

Once verified working, set `dry_run: false` in `config.yaml` and restart.

### Network Requirements for Webhooks

- **Firewall**: Ensure port `3000` (or your configured port) is open
- **Same Network**: If Plex and Audiochangerr are on the same network, use local IP
- **Different Network**: May require port forwarding or reverse proxy
- **Plex Pass**: Active subscription required for webhook functionality

## Usage

1. **Test with dry run** (recommended first):
   ```bash
   npm start
   ```
   Monitor the logs to ensure the configuration works as expected.

2. **Enable live mode**:
   - Set `dry_run: false` in `config.yaml`
   - Run: `npm start`

3. The application will:
   - Monitor active Plex sessions every `check_interval` seconds
   - Detect when transcoding is happening
   - Find a compatible audio stream based on your rules
   - Switch to the compatible stream
   - Terminate the transcode and session
   - Wait for the user to restart playback
   - Validate that the new session uses direct play with the selected stream

## How It Works

1. **Session Monitoring**: Every X seconds (configurable), Audiochangerr fetches active Plex sessions
2. **Transcode Detection**: Identifies sessions with active transcode sessions
3. **Audio Analysis**: Retrieves metadata for the media being played and analyzes available audio streams
4. **Stream Selection**: Applies configured rules to find the best compatible audio stream
5. **Stream Switch**: Changes the selected audio stream for the media
6. **Session Termination**: Stops the transcode and notifies the user to restart playback
7. **Validation**: Waits for the session to restart and confirms direct play is achieved

## Example Scenarios

### Scenario 1: Prefer AC3 5.1
If a user is transcoding a movie with these audio tracks:
- DTS-HD MA 7.1 (currently playing, causing transcode)
- AC3 5.1 English
- AAC 2.0 Stereo

With the default configuration, Audiochangerr will switch to **AC3 5.1** (first matching rule).

### Scenario 2: Exclude Commentary
If available audio tracks include:
- AC3 5.1 English
- AC3 5.1 English Commentary

The `keywords_exclude: ["Commentary"]` rule ensures the commentary track is never selected.

## Logging

Logs are written to the console with different levels:
- **info**: General operation status
- **warn**: Potential issues or fallback actions
- **error**: Failures or critical problems
- **debug**: Detailed information for troubleshooting

## Troubleshooting

**Q: The tool isn't detecting transcodes**
- Verify your `plex_server_url` and `plex_token` are correct
- Check that transcoding is actually happening in Plex Web
- Review logs for API errors

**Q: Audio stream isn't changing**
- Ensure `dry_run: false` is set
- Verify your audio selector rules match available streams
- Check logs for rule matching details

**Q: Works for owner but not managed users**
- Managed users require proper authentication through Plex.tv
- Check logs for managed user token fetch errors

**Q: Webhook mode not receiving webhooks**
- Verify Plex Pass subscription is active
- Check webhook is configured in Plex Web App (Settings > Account > Webhooks)
- Ensure firewall allows the webhook port
- Visit `http://localhost:3000/health` to check webhook status
- Check Audiochangerr logs for connection errors

**Q: Should I use webhook or polling mode?**
- **Use webhook mode if**: You have Plex Pass and want instant response
- **Use polling mode if**: You don't have Plex Pass or prefer simpler setup

## Mode Comparison

| Feature | Webhook Mode | Polling Mode |
|---------|-------------|--------------|
| **Response Time** | Instant (< 1 second) | 10+ seconds |
| **Server Load** | Minimal (event-driven) | Constant API polling |
| **Plex Pass Required** | ✅ Yes | ❌ No |
| **Network Setup** | Port forwarding may be needed | None |
| **Setup Complexity** | Moderate | Simple |
| **Reliability** | Depends on network | More predictable |
| **Recommended For** | Production use with Plex Pass | Testing or non-Plex Pass users |

## Testing

Run unit tests:
```bash
node test-webhook.js
```

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is provided as-is. Please ensure you comply with Plex's terms of service when using this tool.

## Disclaimer

This tool automates Plex server operations. Use at your own risk. Always test with `dry_run: true` before enabling live mode.
