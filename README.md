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

## Configuration

Edit `config.yaml` to configure Audiochangerr:

```yaml
plex_server_url: "http://your-plex-server:32400"
plex_token: "YOUR_PLEX_TOKEN"
owner_username: "YOUR_PLEX_USERNAME"
check_interval: 10  # seconds between session checks
dry_run: true       # set to false to enable actual changes

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
- **check_interval**: How often to check for active sessions (in seconds)
- **dry_run**: When `true`, logs actions without making changes (recommended for testing)

### Audio Selector Rules

Rules are processed **top to bottom**. The first matching stream is selected.

Each rule can specify:
- **codec**: Audio codec (`ac3`, `aac`, `dts`, etc.)
- **channels**: Minimum number of audio channels (e.g., `6` for 5.1, `2` for stereo)
- **language**: Language code (e.g., `eng`, `jpn`) or `original` to match the current stream's language
- **keywords_include** (optional): Stream title must contain at least one of these keywords
- **keywords_exclude** (optional): Stream title must NOT contain any of these keywords (takes precedence)

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

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is provided as-is. Please ensure you comply with Plex's terms of service when using this tool.

## Disclaimer

This tool automates Plex server operations. Use at your own risk. Always test with `dry_run: true` before enabling live mode.
