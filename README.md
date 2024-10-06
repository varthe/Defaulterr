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
```
### Config
See [config.yaml](https://github.com/varthe/Defaulterr/blob/main/config.yaml)

### Obtaining the Client Identifier
Go to `https://plex.tv/api/resources?X-Plex-Token={your_admin_token}` (put your admin token inside the curly braces) and find the `clientIdentifier` of your server
#### Groups
Groups are collections of users with shared filters. They can be named anything you like.

Usernames in groups MUST look EXACTLY like in Plex, including capital and special characters.
Ensure users have access to your libraries.

You can also include ALL users with access to your library by replacing the username with `$ALL`

#### Filters
##### Filters example in [config.yaml](https://github.com/varthe/Defaulterr/blob/main/config.yaml)
Filters consist of the following:
- **Library name**: Name of the library to which the filter applies
  - **Group name**: Name of the group to which the filter applies inside the above library
    - **Type**: Audio or Subtitles
      - **include**: Properties inside MUST appear in the audio stream for the AND include the specified value
      - **exclude**: Properties inside MUST NOT appear in the audio stream OR not be the specified value

You can have multiple groups in a library, and multiple filters in a group. 

The first matching filter going down the list will be applied.  
If no filters match, nothing will be done for that item (aka leave as it is in Plex).

Filters can include any property inside the stream object returned by Plex. See [example.json](https://github.com/varthe/Defaulterr/blob/main/example.json) for a few examples of such objects.
You can start filters with either an **include** or **exclude**. Each separate filter MUST start with a `-`.

### Tautulli webhook
To have filters automatically apply to newly added items you need to set up a Tautulli webhook.
In Tautulli:
  1. Go to **Settings -> Notifications & Newsletters**
  2. Set **Recently Added Notification Delay** to **60**. Note that you should increase this value if your notifications are firing too early.
  3. Go to **Settings -> Notification Agents**
  4. Click on **Add a new notification agent**
  5. Select **Webhook**
  6. Paste the Defaulterr URL inside **Webhook URL**: http://defaulterr:3184/webhook
  7. For **Webhook Method** select **POST**
  8. Go to the **Triggers** tab and tick **Recently Added**
  9. Go to the **Data** tab and click on **Recently Added** 
  10. Paste the following into **JSON Data** and hit **Save**:
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
