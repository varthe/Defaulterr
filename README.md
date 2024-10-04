# Defaulterr

Change the default audio stream for items in Plex per user based on the codec, language, keywords and more. Customizable with filters and groups. Can run on a schedule or for newly added items using a Tautulli webhook.

## Getting Started

### Docker Compose
```
services:
  defaulterr:
    image: varthe/defaulterr
    container_name: defaulterr
    hostname: defaulterr
    ports: 
      - 3184:3184
    volumes:
      - /path/to/config:/config
      - /path/to/logs:/logs
    restart: unless-stopped
```
### Config
#### Groups
Groups are collections of user tokens which will share filters. They can be named anything you like.
Tokens must have access to your server. They are NOT regular tokens. See this [Reddit comment](https://www.reddit.com/r/PleX/comments/18ihi91/comment/kddct4k/?utm_source=share&utm_medium=web3x&utm_name=web3xcss&utm_term=1&utm_content=share_button) by Blind_Watchman on how to obtain access tokens.
#### Filters
Filters consist of the following:
- **Library name**: Name of the library to which the filter applies
  - **Group name**: Name of the group to which the filter applies inside the above library
    - **include**: Properties inside MUST appear in the audio stream for the filter to match
    - **exclude**: Properties inside MUST NOT appear in the audio stream for the filter to match

You can have multiple groups in a library, and multiple filters in a group. 
The first matching filter going down will be applied.  
If no filters match, nothing will be done for that item (aka leave as it is in Plex).
Filters can include any property inside the audio stream object returned by Plex. See [example.json](https://github.com/varthe/Defaulterr/blob/main/example.json) for a few examples of such objects.
You can start filters with either an **include** or **exclude**. Each separate filter MUST start with a `-`.
#### Example config.yaml:
```
plex_url: ''
plex_owner_token: ''

# WARNING: Full and dry runs use a lot of resources in a short burst when ran
dry_run: True # Do a test run without updating. Useful to test filters before commiting
full_run_on_start: False # Update every item in all libraries using the filters when the applicacation is ran
full_run_cron_expression: '' # To do a full run at an interval or time of day. See: https://crontab.guru/

groups:
  serialTranscoders: # Can be named anything
    - token
    - token
  weebs: # Can be named anything
    - token
    - token

filters:
  Movies: # Library name
    serialTranscoders: # Group name
      # Filter 1 - First English track that's not TRUEHD and not a commentary
      - include:
          language: English
        exclude:
          codec: truehd
          extendedDisplayTitle: commentary # Checks whether the word "commentary" is present
      # Filter 2 - Any English track (fallback if the above filter doesn't match)
      - include:
          language: English
    weebs:
      - include:
          language: English
  Anime: # Library name
    weebs: # Group name
      - include:
          languageCode: jpn # Weebs will have movies default to English, and Anime to Japanese
```
### Tautulli webhook
To have filters automatically apply to newly added items you need to set up a Tautulli webhook.
In Tautulli:
  1. Go to **Settings -> Notification Agents**
  2. Click on **Add a new notification agent**
  3. Select **Webhook**
  4. Paste the Defaulterr URL inside **Webhook URL**: http://defaulterr:3184/webhook
  5. For **Webhook Method** select **POST**
  6. Go to the **Triggers** tab and tick **Recently Added**
  7. Go to the **Data** tab and click on **Recently Added** 
  8. Paste the following into **JSON Data** and hit **Save**:
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