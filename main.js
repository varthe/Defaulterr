const express = require("express")
const axios = require("axios")
const logger = require("./logger")
const cron = require("node-cron")
const cronValidator = require("cron-validator")
const xml2js = require("xml2js")
const loadAndValidateYAML = require("./configBuilder")

const config = loadAndValidateYAML()
const app = express()
app.use(express.json())

const STREAM_TYPES = { video: 1, audio: 2, subtitles: 3 }
const LIBRARIES = new Map()
const USERS = new Map()

const axiosInstance = axios.create({
  baseURL: config.plex_url,
  headers: {
    "X-Plex-Token": config.plex_owner_token,
  },
  timeout: 120000
})

// Utility to handle error logging
const handleAxiosError = (context, error) => {
  logger.error(`Error ${context}: ${error.message}`)
}

const batchExecute = async (tasks) => {
  const batchSize = config.update_batch_size
  const batchDelay = config.update_batch_delay
  for (let i = 0; i < tasks.length; i += batchSize) {
    await Promise.all(tasks.slice(i, i + batchSize).map(task => task()))
    if (i + batchSize < tasks.length) await new Promise(resolve => setTimeout(resolve, batchDelay))  
  }
}
const batchReturn = async (tasks) => {
  const batchSize = config.process_batch_size
  const batchDelay = config.process_batch_delay
  const results = []
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(task => task()));
    results.push(...batchResults);
    if (i + batchSize < tasks.length) {
      await new Promise(resolve => setTimeout(resolve, batchDelay)); // Delay after each batch
    }
  }
  return results; 
};

const getUserDetailsFromXml = async (xml) => {
  const parser = new xml2js.Parser()
  try {
    // Parse the XML string
    const result = await parser.parseStringPromise(xml);

    // Extract the data
    const sharedServers = result.MediaContainer.SharedServer;
    const extractedData = sharedServers.map(server => {
        const username = server.$.username;
        const accessToken = server.$.accessToken;
        return { username, accessToken };
    });
    return extractedData;
} catch (error) {
      throw new Error(`Error parsing XML: ${error.message}`)
  }
} 

const fetchAllUsersListedInFilters = async () => {
  try {
    if (!config.plex_client_identifier) throw new Error("Client identifier not supplied in config")
    const response = await axios.get(`https://plex.tv/api/servers/${config.plex_client_identifier}/shared_servers`, { headers: { "X-Plex-Token": config.plex_owner_token, "Accept": "application/json"} })
    const filterUsernames = new Set(Object.values(config.groups).flat())
    const users = await getUserDetailsFromXml(response.data)
    users.forEach(user => {
      if (filterUsernames.has(user.username) || filterUsernames.has("$ALL")) {
        USERS.set(user.username, user.accessToken)
      }
    })
  } catch (error) {
    handleAxiosError("fetching users from server", error)
    process.exit(1)
  }

}
// Verify each token can access the API endpoint
const verifyTokens = async () => {
  USERS.forEach(async (token, username) => {
    await axios
      .get(`${config.plex_url}/library/sections`, { headers: { "X-Plex-Token": token } })
      .then(logger.info(`Validating token for user ${username}... Valid`))
      .catch((error) => {
        handleAxiosError(`validating token for user ${username}: ${error.message}`)
        process.exit(1)
      })
  })
}

const setupCronJob = () => {
  if (config.dry_run || !config.full_run_cron_expression) return
  if (!cronValidator.isValidCron(config.full_run_cron_expression)) throw new Error(`Invalid cron expression: ${config.full_run_cron_expression}`)
  cron.schedule(config.full_run_cron_expression, async () => {
    logger.info(`Running scheduled full run at ${new Date().toISOString()}`)
    await performFullRun()
  })
}

// Fetch all libraries and map by ID
const fetchAllLibraries = async () => {
  try {
    const { data } = await axiosInstance.get("/library/sections")
    const libraries = data?.MediaContainer?.Directory || []
    libraries.forEach(library => {
      if (library.title in config.filters) {
        if (!["movie", "show"].includes(library.type)) throw new Error(`Invalid library type '${library.type}'. Must be 'movie' or 'show'`)
        LIBRARIES.set(library.key, { name: library.title, type: library.type })
      }
    })
  } catch (error) {
    handleAxiosError('fetching libraries', error)
  }
}

// Combined stream filter evaluation (includes and excludes)
const evaluateStream = (stream, filters) => {
  return filters.every(({ include = {}, exclude = {} }) => {
    for (const field in include) {
      const streamValue = stream[field]?.toLowerCase()
      if (!streamValue || !streamValue.includes(include[field].toLowerCase())) return false
    }
    for (const field in exclude) {
      const streamValue = stream[field]?.toLowerCase()
      if (streamValue?.includes(exclude[field].toLowerCase())) return false
    }
    return true
  })
}

// Fetch streams for a specific media item (movie or episode)
const fetchStreamsForItem = async (itemId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${itemId}`)
    const part = data?.MediaContainer?.Metadata[0]?.Media[0]?.Part[0]
    if (!part || !part.id) throw new Error("Invalid media structure from Plex API")
    const streams = part.Stream.filter((stream) => stream.streamType !== STREAM_TYPES.video)
    return { partId: part.id, streams: streams }
    
  } catch (error) {
    handleAxiosError(`fetching streams for Item ID ${itemId}`, error)
    return { partId: itemId, streams: [] } // Return empty streams on error
  }
}

// Fetch all episodes of a season
const fetchStreamsForSeason = async (seasonId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${seasonId}/children`)
    const episodes = data?.MediaContainer?.Metadata || []
    if (episodes.length === 0) {
      logger.warn(`No episodes found for Season ID ${seasonId}`)
      return []
    }
    return await batchReturn(episodes.map(episode => async () => fetchStreamsForItem(episode.ratingKey)))
  } catch (error) {
    handleAxiosError(`fetching episodes for Season ID ${seasonId}`, error)
    return []
  }
}

// Fetch all seasons of a show
const fetchStreamsForShow = async (showId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${showId}/children`)
    const seasons = data?.MediaContainer?.Metadata || []
    if (seasons.length === 0) {
      logger.warn(`No seasons found for show ID ${showId}`)
      return []
    }
    const allStreams = await batchReturn(seasons.map(season => async () => fetchStreamsForSeason(season.ratingKey)))
    return allStreams.flat()
  } catch (error) {
    handleAxiosError(`fetching seasons for Show ID ${showId}`, error)
    return []
  }
}

// Fetch streams for a given library (either movies or TV shows)
const fetchStreamsForLibrary = async (libraryName) => {
  try {
    const { id, type } = await fetchLibraryDetailsByName(libraryName)
    const { data } = await axiosInstance.get(`/library/sections/${id}/all`)
    const items = data?.MediaContainer?.Metadata || []

    if (type === "movie") {
      return await batchReturn(items.map((item) => async () => fetchStreamsForItem(item.ratingKey)))
    } 
    else if (type === "show") {
      const allStreams = await batchReturn(items.map((item) => async () => fetchStreamsForShow(item.ratingKey)))  
      return allStreams.flat()
    }
    throw new Error(`Unsupported library type for '${libraryName}'`)
  } catch (error) {
    handleAxiosError(`fetching streams for Library '${libraryName}'`, error)
    return []
  }
}

// Fetch library details by its name
const fetchLibraryDetailsByName = async (libraryName) => {
  try {
    for (const [key, details] of LIBRARIES.entries()) {
      if (details.name.toLowerCase() === libraryName.toLowerCase()) return { id: key, type: details.type }
    }
    throw new Error(`Library '${libraryName}' not found`)
  } catch (error) {
    handleAxiosError(`fetching library details for '${libraryName}'`, error)
    return { id: null, type: null }
  }
}

// Determine which streams should be updated based on filters
const identifyStreamsToUpdate = async (parts, filters) => {
  try {
    const streamsToUpdate = []

    for (const part of parts) {
      if (part.streams.length <= 1) {
        logger.info(`Part ID ${part.partId} has only one stream. Skipping.`)
        continue
      }
      
      const partUpdate = {partId: part.partId}

      if (filters.audio) {
        const audioStream = part.streams.find((stream) =>
          stream.streamType === STREAM_TYPES.audio && evaluateStream(stream, filters.audio)
        )
        if (audioStream) {
          logger.info(`Part ID ${part.partId}: match found for audio stream ${audioStream.displayTitle}`)
          partUpdate.audioStreamId = audioStream.id
        }
        else {
          logger.info(`Part ID ${part.partId}: no match found for audio streams`)
        }
      }
      if (filters.subtitles) {
        const subtitleStream = part.streams.find((stream) => 
          stream.streamType === STREAM_TYPES.subtitles && evaluateStream(stream, filters.subtitles)
        )
        if (subtitleStream) {
          logger.info(`Part ID ${part.partId}: match found for subtitle stream ${subtitleStream.displayTitle}`)
          partUpdate.subtitleStreamId = subtitleStream.id
        }
        else {
          logger.info(`Part ID ${part.partId}: no match found for subtitle streams`)
        }
      }

      if (partUpdate.audioStreamId || partUpdate.subtitleStreamId) {
        streamsToUpdate.push(partUpdate)
      }
    }
    return streamsToUpdate
  } catch (error) {
    logger.error(`Error while evaluating streams for filter: ${error.message}. Aborting`)
    return []
  }
}

// Identify new streams to update for all libraries and groups
const identifyNewStreamsForFullRun = async () => {
  const updates = []

  for (const libraryName in config.filters) {
    const libraryStreams = await fetchStreamsForLibrary(libraryName)
    for (const group in config.filters[libraryName]) {
      const streamsToUpdate = await identifyStreamsToUpdate(libraryStreams, config.filters[libraryName][group])
      if (streamsToUpdate.length > 0) {
        updates.push({ group, newStreams: streamsToUpdate })
      }
    }
  }
  return updates
}

// Update default streams across groups
const updateDefaultStreams = async (updates) => {
  for (const { group, newStreams } of updates) {
    var usernames = config.groups[group] || []
    if (usernames.includes("$ALL")) usernames = [...USERS.keys()]
    if (usernames.length === 0) throw new Error("No groups found in config. Aborting update")
    
    const tasks = usernames.flatMap(username => 
      newStreams.map((stream) => async () => {
        const queryParams = new URLSearchParams()
        if (stream.audioStreamId) queryParams.append('audioStreamID', stream.audioStreamId)
        if (stream.subtitleStreamId) queryParams.append('subtitleStreamID', stream.subtitleStreamId)
        return axiosInstance
          .post(`/library/parts/${stream.partId}?${queryParams.toString()}`, {}, { headers: { "X-Plex-Token": USERS.get(username) } })
          .then((response) => {
            const audioMessage = stream.audioStreamId ? `Audio ID ${stream.audioStreamId}` : ''
            const subtitleMessage = stream.subtitleStreamId ? `Subtitle ID ${stream.subtitleStreamId}` : ''
            const updateMessage = [audioMessage, subtitleMessage].filter(Boolean).join(' and ')
            logger.info(`Update ${updateMessage} for user ${username} in group ${group}: ${response.status === 200 ? 'SUCCESS' : 'FAIL'}`)
          })
          .catch((error) => {
            logger.error(`Error posting update for group ${group}: ${error.message}`)
          })
      })
    )
    await batchExecute(tasks)
  }
}

// Dry run to identify streams without applying updates
const performDryRun = async () => {
  logger.info("STARTING DRY RUN. NO CHANGES WILL BE MADE.")
  await identifyNewStreamsForFullRun()
  logger.info("DRY RUN COMPLETE.")
}

// Full run to update all streams
const performFullRun = async () => {
  logger.info("STARTING FULL RUN.")
  const updates = await identifyNewStreamsForFullRun()
  await updateDefaultStreams(updates)
  logger.info("FULL RUN COMPLETE.")
}

// Tautulli webhook for new items
app.post("/webhook", async (req, res) => {
  try {
    logger.info("Tautulli webhook received. Processing...")

    const { type, libraryId, mediaId } = req.body
    if (!type || !libraryId || !mediaId) throw new Error("Error getting request body")

    const libraryName = LIBRARIES.get(libraryId)?.name // LIBRARIES only has libraries present in filters
    if (!libraryName) {
      logger.info(`Library ID ${libraryId} not found in filters. Ending request`)
      return res.status(200).send("Event not relevant")
    }
    const filters = config.filters[libraryName]
    
    let streams = [] // Need arrays for identifyStreamsToUpdate
    if (type === "movie" || type === "epsiode") streams = [await fetchStreamsForItem(mediaId, STREAM_TYPES.audio)]
    else if (type === "show") streams = await fetchStreamsForShow(mediaId)
    else if (type === "season") streams = await fetchStreamsForSeason(mediaId)
    // else do nothing

    const updates = []
    for (const group in filters) {
      const newStreams = await identifyStreamsToUpdate(streams, filters[group])
      if (!newStreams || newStreams.length === 0){
        logger.info("Could not find streams to update. Ending request")
        return res.status(200).send("Event not relevant")
      }
      updates.push({group: group, newStreams: newStreams})
    }
    await updateDefaultStreams(updates)
    logger.info("Tautulli webhook finished")
    return res.status(200).send("Webhook received and processed.")
  } catch (error) {
    logger.error(`Error processing webhook: ${error.message}`)
    res.status(500).send("Error processing webhook")
  }
})
// Handle uncaught exceptions and unhandled rejections
process.on("uncaughtException", (error) => logger.error(`Uncaught exception: ${error.message}`))
process.on("unhandledRejection", (reason) => logger.error(`Unhandled rejection: ${reason}`))

// Initializing the application
const PORT = process.env.PORT || 3184
app.listen(PORT, async () => {
  logger.info(`Server is running on port ${PORT}`)
  try {
    USERS.set(config.plex_owner_name, config.plex_owner_token)
    await fetchAllUsersListedInFilters()
    await verifyTokens()
    await fetchAllLibraries()
    setupCronJob()

    if (config.dry_run) await performDryRun()
    else if (config.full_run_on_start) await performFullRun()
  } catch (error) {
    logger.error(`Error initializing the application: ${error.message}`)
    process.exit(1)
  }
})
