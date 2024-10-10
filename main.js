const express = require("express");
const fs = require("fs")
const path = require("path")
const axios = require("axios");
const logger = require("./logger");
const cron = require("node-cron");
const cronValidator = require("cron-validator");
const xml2js = require("xml2js");
const loadAndValidateYAML = require("./configBuilder");
const http = require("http");
const https = require("https");

const config = loadAndValidateYAML();
const app = express();
app.use(express.json());

const STREAM_TYPES = { video: 1, audio: 2, subtitles: 3 };
const LIBRARIES = new Map();
const USERS = new Map();
const timestampsFile = path.join('./config', "last_run_timestamps.json");

// Create an Axios instance with increased timeout and keep-alive
const axiosInstance = axios.create({
  baseURL: config.plex_server_url,
  headers: {
    "X-Plex-Token": config.plex_owner_token,
  },
  timeout: config.timeout || 3600000, // Set to 1 hour by default
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// Utility to handle error logging
const handleAxiosError = (context, error) => {
  if (error.response) {
    logger.error(`Error ${context}: ${error.response.status} - ${error.response.statusText}`);
  } else if (error.request) {
    logger.error(`Error ${context}: No response received.`);
  } else {
    logger.error(`Error ${context}: ${error.message}`);
  }
};

// Function to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to parse user details from XML
const getUserDetailsFromXml = async (xml) => {
  const parser = new xml2js.Parser();
  try {
    const result = await parser.parseStringPromise(xml);
    const sharedServers = result.MediaContainer.SharedServer || [];
    const extractedData = sharedServers.map((server) => {
      const username = server.$.username;
      const accessToken = server.$.accessToken;
      return { username, accessToken };
    });
    return extractedData;
  } catch (error) {
    throw new Error(`Error parsing XML: ${error.message}`);
  }
};

// Fetch all users listed in filters
const fetchAllUsersListedInFilters = async () => {
  try {
    if (!config.plex_client_identifier) throw new Error("Client identifier not supplied in config");
    const response = await axios.get(
      `https://plex.tv/api/servers/${config.plex_client_identifier}/shared_servers`,
      {
        headers: {
          "X-Plex-Token": config.plex_owner_token,
          Accept: "application/json",
        },
      }
    );
    const filterUsernames = new Set(Object.values(config.groups).flat());
    const users = await getUserDetailsFromXml(response.data);
    users.forEach((user) => {
      if (filterUsernames.has(user.username) || filterUsernames.has("$ALL")) {
        USERS.set(user.username, user.accessToken);
      }
    });
    logger.info("Fetched and stored user details successfully.");
  } catch (error) {
    handleAxiosError("fetching users from server", error);
    process.exit(1);
  }
};

// Verify each token can access the API endpoint
const verifyTokens = async () => {
  for (const [username, token] of USERS.entries()) {
    try {
      await axios.get(`${config.plex_server_url}/library/sections`, {
        headers: { "X-Plex-Token": token },
      });
      logger.info(`Validating token for user ${username}... Valid`);
    } catch (error) {
      handleAxiosError(`validating token for user ${username}`, error);
      process.exit(1);
    }
    // Optional: Delay between token verifications to reduce load
    await delay(100); // 100ms delay
  }
};

// Setup Cron Job
const setupCronJob = () => {
  if (config.dry_run || !config.partial_run_cron_expression) return;
  if (!cronValidator.isValidCron(config.partial_run_cron_expression))
    throw new Error(`Invalid cron expression: ${config.partial_run_cron_expression}`);
  cron.schedule(config.partial_run_cron_expression, async () => {
    logger.info(`Running scheduled partial run at ${new Date().toISOString()}`);
    await performPartialRun();
  });
};

// Fetch all libraries and map by ID
const fetchAllLibraries = async () => {
  try {
    const { data } = await axiosInstance.get("/library/sections");
    const libraries = data?.MediaContainer?.Directory || [];
    libraries.forEach((library) => {
      if (library.title in config.filters) {
        if (!["movie", "show"].includes(library.type))
          throw new Error(`Invalid library type '${library.type}'. Must be 'movie' or 'show'`);
        LIBRARIES.set(library.key, { name: library.title, type: library.type });
        logger.info(`Mapped library: ${library.title} (ID: ${library.key}, Type: ${library.type})`);
      }
    });
    logger.info("Fetched and mapped all relevant libraries.");
  } catch (error) {
    handleAxiosError("fetching libraries", error);
  }
};

// Load last run timestamps from the file
const loadLastRunTimestamps = () => {
  if (fs.existsSync(timestampsFile)) {
    const data = fs.readFileSync(timestampsFile, "utf-8");
    return JSON.parse(data);
  }
  return {};
};

// Save the new last run timestamps to the file
const saveLastRunTimestamps = (timestamps) => {
  fs.writeFileSync(timestampsFile, JSON.stringify(timestamps, null, 2), "utf-8");
};

// Fetch media items that were updated after a specific timestamp
const fetchUpdatedMediaItems = async (libraryId, lastUpdatedAt) => {
  try {
    const { data } = await axiosInstance.get(`/library/sections/${libraryId}/all`);
    const items = data?.MediaContainer?.Metadata || [];

    // Filter items updated after the last known updatedAt timestamp
    return items.filter(item => item.updatedAt > lastUpdatedAt);
  } catch (error) {
    handleAxiosError(`fetching updated media for Library ID ${libraryId}`, error);
    return [];
  }
};

// Optimized evaluateStream function using .some
const evaluateStream = (stream, filters) => {
  return filters.every(({ include = {}, exclude = {} }) => {
    // Check 'include' conditions
    const includesFail = Object.keys(include).some((field) => {
      const streamValue = stream[field]?.toLowerCase();
      return !streamValue || !streamValue.includes(include[field].toLowerCase());
    });
    if (includesFail) return false;

    // Check 'exclude' conditions
    const excludesFail = Object.keys(exclude).some((field) => {
      const streamValue = stream[field]?.toLowerCase();
      return streamValue?.includes(exclude[field].toLowerCase());
    });
    return !excludesFail;
  });
};

// Fetch streams for a specific media item (movie or episode)
const fetchStreamsForItem = async (itemId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${itemId}`);
    const part = data?.MediaContainer?.Metadata[0]?.Media[0]?.Part[0];
    if (!part || !part.id || !part.Stream) {
      logger.warn(`Item ID ${itemId} has invalid media structure. Skipping.`);
      return { partId: itemId, streams: [] };
    }
    const streams = part.Stream.filter((stream) => stream.streamType !== STREAM_TYPES.video);
    return { partId: part.id, streams: streams };
  } catch (error) {
    handleAxiosError(`fetching streams for Item ID ${itemId}`, error);
    return { partId: itemId, streams: [] }; // Return empty streams on error
  }
};

// Fetch all episodes of a season
const fetchStreamsForSeason = async (seasonId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${seasonId}/children`);
    const episodes = data?.MediaContainer?.Metadata || [];
    if (episodes.length === 0) {
      logger.warn(`No episodes found for Season ID ${seasonId}`);
      return [];
    }
    // Fetch streams for each episode sequentially
    const streams = [];
    for (const episode of episodes) {
      const stream = await fetchStreamsForItem(episode.ratingKey);
      streams.push(stream);
      // Optional: Delay between fetching each episode to reduce load
      await delay(100);
    }
    return streams;
  } catch (error) {
    handleAxiosError(`fetching episodes for Season ID ${seasonId}`, error);
    return [];
  }
};

// Fetch all seasons of a show
const fetchStreamsForShow = async (showId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${showId}/children`);
    const seasons = data?.MediaContainer?.Metadata || [];
    if (seasons.length === 0) {
      logger.warn(`No seasons found for Show ID ${showId}`);
      return [];
    }
    const streams = [];
    for (const season of seasons) {
      const seasonStreams = await fetchStreamsForSeason(season.ratingKey);
      streams.push(...seasonStreams);
      // Optional: Delay between fetching each season to reduce load
      await delay(100); // 100ms delay
    }
    return streams;
  } catch (error) {
    handleAxiosError(`fetching seasons for Show ID ${showId}`, error);
    return [];
  }
};

// Fetch streams for a given library (either movies or TV shows)
const fetchStreamsForLibrary = async (libraryName) => {
  try {
    const { id, type } = await fetchLibraryDetailsByName(libraryName);
    if (!id || !type) {
      logger.warn(`Library '${libraryName}' details are incomplete. Skipping.`);
      return [];
    }
    const { data } = await axiosInstance.get(`/library/sections/${id}/all`);
    const items = data?.MediaContainer?.Metadata || [];

    const streams = [];
    for (const item of items) {
      if (type === "movie") {
        const stream = await fetchStreamsForItem(item.ratingKey);
        streams.push(stream);
        // Optional: Delay between fetching each movie to reduce load
        await delay(100); // 50ms delay
      } else if (type === "show") {
        const showStreams = await fetchStreamsForShow(item.ratingKey);
        streams.push(...showStreams);
        // Optional: Delay between fetching each show to reduce load
        await delay(100); // 100ms delay
      }
    }
    return streams;
  } catch (error) {
    handleAxiosError(`fetching streams for Library '${libraryName}'`, error);
    return [];
  }
};

// Fetch library details by its name
const fetchLibraryDetailsByName = async (libraryName) => {
  try {
    for (const [key, details] of LIBRARIES.entries()) {
      if (details.name.toLowerCase() === libraryName.toLowerCase()) {
        return { id: key, type: details.type };
      }
    }
    throw new Error(`Library '${libraryName}' not found`);
  } catch (error) {
    handleAxiosError(`fetching library details for '${libraryName}'`, error);
    return { id: null, type: null };
  }
};

// Determine which streams should be updated based on filters
const identifyStreamsToUpdate = async (parts, filters) => {
  try {
    const streamsToUpdate = [];

    for (const part of parts) {
      if (!part.streams || part.streams.length <= 1) {
        logger.info(`Part ID ${part.partId} has only one stream. Skipping.`);
        continue;
      }

      const partUpdate = { partId: part.partId };

      if (filters.audio) {
        const audioStream = part.streams.find(
          (stream) => stream.streamType === STREAM_TYPES.audio && evaluateStream(stream, filters.audio)
        );
        if (audioStream) {
          logger.info(`Part ID ${part.partId}: match found for audio stream ${audioStream.displayTitle}`);
          partUpdate.audioStreamId = audioStream.id;
        } else {
          logger.info(`Part ID ${part.partId}: no match found for audio streams`);
        }
      }

      if (filters.subtitles) {
        const subtitleStream = part.streams.find(
          (stream) => stream.streamType === STREAM_TYPES.subtitles && evaluateStream(stream, filters.subtitles)
        );
        if (subtitleStream) {
          logger.info(`Part ID ${part.partId}: match found for subtitle stream ${subtitleStream.displayTitle}`);
          partUpdate.subtitleStreamId = subtitleStream.id;
        } else {
          logger.info(`Part ID ${part.partId}: no match found for subtitle streams`);
        }
      }

      if (partUpdate.audioStreamId || partUpdate.subtitleStreamId) {
        streamsToUpdate.push(partUpdate);
      }
    }
    return streamsToUpdate;
  } catch (error) {
    logger.error(`Error while evaluating streams for filter: ${error.message}. Aborting`);
    return [];
  }
};

// Update default streams for a single item across all relevant users
const updateDefaultStreamsPerItem = async (streamsToUpdate, filters) => {
  for (const stream of streamsToUpdate) {
    for (const group in filters) {
      let usernames = config.groups[group] || [];
      if (usernames.includes("$ALL")) usernames = [...USERS.keys()];
      if (usernames.length === 0) {
        logger.warn(`No users found in group '${group}'. Skipping update.`);
        continue;
      }

      for (const username of usernames) {
        const token = USERS.get(username);
        if (!token) {
          logger.warn(`No access token found for user '${username}'. Skipping update.`);
          continue;
        }

        const queryParams = new URLSearchParams();
        if (stream.audioStreamId) queryParams.append("audioStreamID", stream.audioStreamId);
        if (stream.subtitleStreamId) queryParams.append("subtitleStreamID", stream.subtitleStreamId);

        try {
          const response = await axiosInstance.post(
            `/library/parts/${stream.partId}?${queryParams.toString()}`,
            {},
            { headers: { "X-Plex-Token": token } }
          )
          .catch(async (error) => {
            logger.error(`Error while posting update for user ${username} in group ${group}: ${error.message}. Retrying in 30 sec...`)
            await delay(30000)
            let responseStatus = ''
            let attempt = 1;
            while (responseStatus !== 200 && attempt < 10) {
              await axiosInstance.post(
                `/library/parts/${stream.partId}?${queryParams.toString()}`,
                {},
                { headers: { "X-Plex-Token": token } }
              )
              .then((response) => responseStatus = response.status)
              .catch((error) => {
                logger.error(`Attempt ${attempt}/10 failed with error: ${error.message}. Retrying in 30 sec...`)
              })
              if (responseStatus !== 200) {
                attempt++
                await delay(30000)
              }
            }
            if (responseStatus !== 200) {
              logger.error("All attemps failed. Exiting application.")
              process.exit(1)
            }
          });

          const audioMessage = stream.audioStreamId ? `Audio ID ${stream.audioStreamId}` : "";
          const subtitleMessage = stream.subtitleStreamId ? `Subtitle ID ${stream.subtitleStreamId}` : "";
          const updateMessage = [audioMessage, subtitleMessage].filter(Boolean).join(" and ");
          logger.info(
            `Update ${updateMessage} for user ${username} in group ${group}: ${
              response.status === 200 ? "SUCCESS" : "FAIL"
            }`
          );
        } catch (error) {
          handleAxiosError(`posting update for user '${username}' in group '${group}'`, error);
        }
        await delay(100); // 50ms delay
      }
    }
  }
};

// Identify new streams and update them one by one per item for each user
const identifyAndUpdateStreamsPerItem = async () => {
  for (const libraryName in config.filters) {
    logger.info(`Processing library: ${libraryName}`);
    const libraryStreams = await fetchStreamsForLibrary(libraryName);
    for (const stream of libraryStreams) {
      const updates = [];
      for (const group in config.filters[libraryName]) {
        const newStreams = await identifyStreamsToUpdate([stream], config.filters[libraryName][group]);
        if (newStreams.length > 0) {
          updates.push(...newStreams);
        }
      }
      if (updates.length > 0 && !config.dry_run) {
        await updateDefaultStreamsPerItem(updates, config.filters[libraryName]);
      }
      // Optional: Delay between processing each stream to reduce load
      await delay(200); // 200ms delay
    }
  }
};

// Dry run to identify streams without applying updates
const performDryRun = async () => {
  logger.info("STARTING DRY RUN. NO CHANGES WILL BE MADE.");
  await identifyAndUpdateStreamsPerItem();
  logger.info("DRY RUN COMPLETE.");
};

// Partial run: process items updated since last run
const performPartialRun = async () => {
  logger.info("STARTING PARTIAL RUN.");

  const lastRunTimestamps = loadLastRunTimestamps();
  const newTimestamps = {};

  for (const libraryName in config.filters) {
      logger.info(`Processing library for partial run: ${libraryName}`);
      const { id, type } = await fetchLibraryDetailsByName(libraryName);
      if (!id || !type) {
          logger.warn(`Library '${libraryName}' details are incomplete. Skipping.`);
          continue;
      }
      const lastUpdatedAt = lastRunTimestamps[libraryName] || 0;

      // Fetch updated media items based on updatedAt timestamp
      const updatedItems = await fetchUpdatedMediaItems(id, lastUpdatedAt);

      if (type === "movie") {
          for (const item of updatedItems) {
              const stream = await fetchStreamsForItem(item.ratingKey);
              const groupFilters = config.filters[libraryName];
              const newStreams = [];

              for (const group in groupFilters) {
                  const matchedStreams = await identifyStreamsToUpdate([stream], groupFilters[group]);
                  if (matchedStreams.length > 0) {
                      newStreams.push(...matchedStreams);
                  }
              }

              if (newStreams.length > 0) {
                  await updateDefaultStreamsPerItem(newStreams, config.filters[libraryName]);
              }

              // Optional: Delay between processing each item to reduce load
              await delay(100); // 100ms delay
          }
      } else if (type === "show") {
          for (const item of updatedItems) {
              const showStreams = await fetchStreamsForShow(item.ratingKey);
              for (const stream of showStreams) {
                  const groupFilters = config.filters[libraryName];
                  const newStreams = [];

                  for (const group in groupFilters) {
                      const matchedStreams = await identifyStreamsToUpdate([stream], groupFilters[group]);
                      if (matchedStreams.length > 0) {
                          newStreams.push(...matchedStreams);
                      }
                  }

                  if (newStreams.length > 0 && !config.dry_run) {
                      await updateDefaultStreamsPerItem(newStreams, config.filters[libraryName]);
                  }

                  // Optional: Delay between processing each stream to reduce load
                  await delay(100); // 100ms delay
              }
          }
      }

      // Update the timestamp for the current library
      if (updatedItems.length > 0) {
          const latestUpdatedAt = Math.max(...updatedItems.map(item => item.updatedAt));
          newTimestamps[libraryName] = latestUpdatedAt;
      }
  }

  // Save the updated timestamps for future runs
  saveLastRunTimestamps({ ...lastRunTimestamps, ...newTimestamps });

  logger.info("PARTIAL RUN COMPLETE.");
};


// Tautulli webhook for new items
app.post("/webhook", async (req, res) => {
  try {
    logger.info("Tautulli webhook received. Processing...");

    const { type, libraryId, mediaId } = req.body;
    if (!type || !libraryId || !mediaId) throw new Error("Error getting request body");

    const libraryName = LIBRARIES.get(libraryId)?.name; // LIBRARIES only has libraries present in filters
    if (!libraryName) {
      logger.info(`Library ID ${libraryId} not found in filters. Ending request`);
      return res.status(200).send("Event not relevant");
    }
    const filters = config.filters[libraryName];

    let streams = []; // Need arrays for identifyStreamsToUpdate
    if (type === "movie" || type === "episode") {
      streams = [await fetchStreamsForItem(mediaId)];
    } else if (type === "show") {
      streams = await fetchStreamsForShow(mediaId);
    } else if (type === "season") {
      streams = await fetchStreamsForSeason(mediaId);
    }
    // else do nothing

    const updates = [];
    for (const group in filters) {
      const newStreams = await identifyStreamsToUpdate(streams, filters[group]);
      if (!newStreams || newStreams.length === 0) {
        logger.info("Could not find streams to update. Ending request");
        continue;
      }
      updates.push({ group, newStreams });
    }

    for (const { group, newStreams } of updates) {
      let usernames = config.groups[group] || [];
      if (usernames.includes("$ALL")) usernames = [...USERS.keys()];
      if (usernames.length === 0) {
        logger.warn(`No users found in group '${group}'. Skipping update.`);
        continue;
      }

      for (const username of usernames) {
        const token = USERS.get(username);
        if (!token) {
          logger.warn(`No access token found for user '${username}'. Skipping update.`);
          continue;
        }

        for (const stream of newStreams) {
          const queryParams = new URLSearchParams();
          if (stream.audioStreamId) queryParams.append("audioStreamID", stream.audioStreamId);
          if (stream.subtitleStreamId) queryParams.append("subtitleStreamID", stream.subtitleStreamId);

          try {
            const response = await axiosInstance.post(
              `/library/parts/${stream.partId}?${queryParams.toString()}`,
              {},
              { headers: { "X-Plex-Token": token } }
            );

            const audioMessage = stream.audioStreamId ? `Audio ID ${stream.audioStreamId}` : "";
            const subtitleMessage = stream.subtitleStreamId ? `Subtitle ID ${stream.subtitleStreamId}` : "";
            const updateMessage = [audioMessage, subtitleMessage].filter(Boolean).join(" and ");
            logger.info(
              `Update ${updateMessage} for user ${username} in group ${group}: ${
                response.status === 200 ? "SUCCESS" : "FAIL"
              }`
            );
          } catch (error) {
            handleAxiosError(`posting update for user '${username}' in group '${group}'`, error);
          }

          // Optional: Delay between posting each update to reduce load
          await delay(100); // 50ms delay
        }
      }
    }

    logger.info("Tautulli webhook finished");
    return res.status(200).send("Webhook received and processed.");
  } catch (error) {
    logger.error(`Error processing webhook: ${error.message}`);
    res.status(500).send("Error processing webhook");
  }
});

// Handle uncaught exceptions and unhandled rejections
process.on("uncaughtException", (error) =>
  logger.error(`Uncaught exception: ${error.message}`)
);
process.on("unhandledRejection", (reason) =>
  logger.error(`Unhandled rejection: ${reason}`)
);

// Initializing the application
const PORT = process.env.PORT || 3184;
app.listen(PORT, async () => {
  logger.info(`Server is running on port ${PORT}`);
  try {
    if (config.plex_owner_name) {
      USERS.set(config.plex_owner_name, config.plex_owner_token);
    }

    await fetchAllUsersListedInFilters();
    await verifyTokens();
    await fetchAllLibraries();
    setupCronJob();

    if (config.dry_run) await performDryRun();
    else if (config.partial_run_on_start) await performPartialRun();
  } catch (error) {
    logger.error(`Error initializing the application: ${error.message}`);
    process.exit(1);
  }
});
