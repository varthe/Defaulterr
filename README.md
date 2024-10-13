# Defaulterr

Change the default audio and subtitle streams for items in Plex per user based on codec, language, keywords and more. Customizable with filters and groups. Can run on a schedule or for newly added items using a Tautulli webhook.

## Getting Started

### Docker Compose

```yaml
services:
  defaulterr:
    image: varthe/defaulterr:latest
    container_name: defaulterr
    hostname: defaulterr
    ports:
      - 3184:3184
    volumes:
      - /path/to/config:/config
      - /path/to/logs:/logs
```

### Configuration Overview

Your configuration is defined in `config.yaml`. Below is a breakdown of the required settings and optional configurations.
See [config.yaml](https://github.com/varthe/Defaulterr/blob/main/config.yaml) for an example of an implementation.

#### REQUIRED SETTINGS

- **plex_server_url**: Your Plex server URL.
- **plex_owner_name**: Used to identify the owner, allowing them to be included in groups.
- **plex_owner_token**: The server owner's token.
- **plex_client_identifier**: Find this value using the instructions below.

#### Obtaining the Client Identifier

1. Go to `https://plex.tv/api/resources?X-Plex-Token={your_admin_token}` (replace `{your_admin_token}` with your token).
2. Search for your server and find the `clientIdentifier` value. This **HAS TO** be the server's identifier, not the owner's.

#### RUN SETTINGS

- **dry_run**: Set to `True` to test filters. This mode won't update users and is recommended to verify that your filters work correctly. It overwrites other run settings.
- **partial_run_on_start**: Set to `True` to do a partial run on application start.
  - **WARNING**: The first run may take a LONG time to complete as it will update all existing media. Subsequent runs will only update any new items added since the last run.
- **partial_run_cron_expression**: Specify a cron expression (e.g., `0 3 * * *` for daily at 3:00 AM) to do a partial run on a schedule. It is recommended to only use this or the Tautulli webhook, not both simultaneously.

#### GROUPS

Groups define collections of users with shared filters:

- Usernames must match **exactly** as they appear in Plex, including capitalization and special characters.
- Managed accounts require additional setup. Read below.
- Optionally, use `$ALL` in place of a username to include all users from your server.

Example:

```yaml
groups:
  serialTranscoders: # Can be named anything
    - varthe
    - UserWithCapitalLetters # EXACTLY like in Plex
    - $ALL # Grabs all users from the server
  subtitleEnjoyers: # Can be named anything
    - varthe
  deafPeople: # Can be named anything
    - varthe
  weebs: # Can be named anything
    - varthe
```

#### MANAGED ACCOUNTS (optional)

To include managed accounts in groups you will need to supply their tokens manually.
See this [comment](https://www.reddit.com/r/PleX/comments/18ihi91/comment/kddct4k/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&utm_term=1&utm_content=share_button) by Blind_Watchman on how to obtain their tokens. You have to do it like this because the regular tokens won't work.

Include them in the config file like below. Use the key (e.g `user1`) in groups.

```yaml
managed_users:
  user1: token
  user2: token
```

#### FILTERS

Filters define how audio and subtitle streams are updated based on specified criteria. The structure in `config.yaml` is as follows:

- **Library Name**: The filter applies to a specific Plex library.
  - **Group Name**: Defines which group the filter targets.
    - **Stream Type**: Can be `audio` or `subtitles`.
      - **include**: Fields that MUST appear in the stream AND include the specified value
      - **exclude**: Fields that MUST NOT appear in the stream OR not be the specified value

Multiple groups and filters can be defined per library, with the first matching filter being applied. If no filters match, the item remains unchanged in Plex. Filters can utilize any property in the stream object returned by Plex. See [example.json](https://github.com/varthe/Defaulterr/blob/main/example.json) for examples.

```yaml
filters:
  Movies: # Library name
    serialTranscoders: # Group name
      audio:
        # Audio Filter 1 - First English audio track that's not TRUEHD and not a commentary
        - include:
            language: English
          exclude:
            codec: truehd
            extendedDisplayTitle: commentary
        # Audio Filter 2 - Any English track (fallback if the above filter doesn't match)
        - include:
            language: English
    subtitleEnjoyers:
      subtitles:
        # Subtitle Filter 1 - First English track that's not forced
        - include:
            language: English
          exclude:
            extendedDisplayTitle: forced
    deafPeople:
      subtitles:
        # Subtitle Filter 1 - First English SDH track
        - include:
            language: English
            hearingImpaired: true # SDH
  Anime: # Library name
    weebs: # Group name
      audio:
        # Audio Filter 1 - First Japanese track
        - include:
            languageCode: jpn # Japanese
      subtitles:
        # Full subtitles -> Dialogue subtitles -> Anything without the word "signs"
        - include:
            language: English
            extendedDisplayTitle: full
        - include:
            language: English
            extendedDisplayTitle: dialogue
        - include:
            language: English
          exclude:
            extendedDisplayTitle: signs
```

### Tautulli Webhook Integration

To automate filter applications for newly added items:

1. Go to **Settings -> Notifications & Newsletters** in Tautulli.
2. Set **Recently Added Notification Delay** to **60** (increase if notifications are firing too early).
3. Navigate to **Settings -> Notification Agents**.
4. Add a new notification agent and select **Webhook**.
5. Use the Defaulterr URL: `http://defaulterr:3184/webhook`.
6. Choose **POST** for the Webhook Method.
7. Enable the **Recently Added** trigger.
8. Paste the following JSON data into **JSON Data**:

```
<movie>
{
  "type": "movie",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</movie>

<show>
{
  "type": "show",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</show>

<season>
{
  "type": "season",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</season>

<episode>
{
  "type": "episode",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</episode>
```
