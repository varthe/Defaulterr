const express = require("express")
const axios = require("axios")
const logger = require("./logger")
const cron = require("node-cron")
const cronValidator = require("cron-validator")
const loadAndValidateYAML = require("./configBuilder")

const config = loadAndValidateYAML()
const app = express()
app.use(express.json())

const STREAM_TYPES = { video: 1, audio: 2, subtitles: 3 }
const LIBRARIES = new Map()

const axiosInstance = axios.create({
  baseURL: config.plex_url,
  headers: {
    "X-Plex-Token": config.plex_owner_token,
  },
})

// Utility to handle error logging
const handleAxiosError = (context, error) => {
  logger.error(`${context}: ${error.message}`)
}

// Verify each token can access the API endpoint
const verifyTokens = async () => {
  const tokens = Object.values(config.groups).flat()
  await Promise.all(
    tokens.map(async (token) => {
      try {
        await axios.get(`${config.plex_url}/library/sections`, {
          headers: { "X-Plex-Token": token },
        })
        logger.info(`Validating token ${token}... Valid`)
      } catch (error) {
        logger.error(`Error validating token: ${error.message}`)
        process.exit(1)
      }
    })
  )
}

const setupCronJob = () => {
  if (config.dry_run || !config.full_run_cron_expression) return
  const expression = config.full_run_cron_expression
  if (!cronValidator.isValidCron(expression)) throw new Error(`Invalid cron expression: ${expression}`)
  cron.schedule(expression, async () => {
    logger.info(`Running scheduled full run at ${new Date().toISOString()}`)
    await performFullRun()
  })
}

// Fetch all libraries and map by ID
const fetchAllLibraries = async () => {
  try {
    const { data } = await axiosInstance.get("/library/sections")
    const libraries = data?.MediaContainer?.Directory || []
    libraries.forEach(async (library) => {
      if (!(library.title in config.filters)) return
      if (!["movie", "show"].includes(library.type)) throw new Error(`Invalid library type '${library.type}'. Must be 'movie' or 'show'`)
      LIBRARIES.set(library.key, { name: library.title, type: library.type })
    })
  } catch (error) {
    logger.error(`Error fetching libraries: ${error.message}`)
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
    return { partId: part.id, streams }
  } catch (error) {
    handleAxiosError(`Fetching streams for Item ID ${itemId}`, error)
    return { partId: itemId, streams: [] } // Return empty streams on error
  }
}

// Fetch all episodes of a season
const fetchStreamsForSeason = async (seasonId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${seasonId}/children`)
    const episodes = data?.MediaContainer?.Metadata || []
    return Promise.all(episodes.map((episode) => fetchStreamsForItem(episode.ratingKey)))
  } catch (error) {
    handleAxiosError(`Fetching episodes for Season ID ${seasonId}`, error)
    return []
  }
}

// Fetch all seasons of a show
const fetchStreamsForShow = async (showId) => {
  try {
    const { data } = await axiosInstance.get(`/library/metadata/${showId}/children`)
    const seasons = data?.MediaContainer?.Metadata || []
    return (await Promise.all(seasons.map((season) => fetchStreamsForSeason(season.ratingKey)))).flat()
  } catch (error) {
    handleAxiosError(`Fetching seasons for Show ID ${showId}`, error)
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
      return Promise.all(items.map((item) => fetchStreamsForItem(item.ratingKey)))
    } else if (type === "show") {
      return (await Promise.all(items.map((item) => fetchStreamsForShow(item.ratingKey)))).flat()
    }
    throw new Error(`Unsupported library type for '${libraryName}'`)
  } catch (error) {
    handleAxiosError(`Fetching streams for Library '${libraryName}'`, error)
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
    handleAxiosError(`Fetching library details for '${libraryName}'`, error)
    return { id: null, type: null }
  }
}

// Determine which streams should be updated based on filters
const identifyStreamsToUpdate = async (parts, filters) => {
  try {
    const streamsToUpdate = []
    var subCount = 0
    var audioCount = 0
    for (const part of parts) {
      if (part.streams.length <= 1) {
        logger.info(`Part ID ${part.partId} only one stream present. Skipping`)
        continue
      }
      const partUpdate = {partId: part.partId}

      const audioStreams = part.streams.filter((stream) => stream.streamType === STREAM_TYPES.audio)
      const subtitleStreams = part.streams.filter((stream) => stream.streamType === STREAM_TYPES.subtitles)

      if (audioStreams && audioStreams.length > 1) {
        for (const audioStream of audioStreams) {
          if (evaluateStream(audioStream, filters.audio)) {
            logger.info(`Part ID ${part.partId}: match found for audio stream '${audioStream.displayTitle}'`)
            //streamsToUpdate.push({ partId: part.partId, audioStreamId: stream.id })
            partUpdate.audioStreamId = audioStream.id
            break
          }
        }
      }
      else {
        logger.info(`Part ID ${part.partId}: only one audio stream present. Skipping`)
      } 
      
      if (!partUpdate.audioStreamId) logger.info(`Part ID ${part.partId}: no match found for audio streams. Skipping`)

      if (subtitleStreams && subtitleStreams.length > 1) {
        for (const subtitleStream of subtitleStreams) {
          if (evaluateStream(subtitleStream, filters.subtitles)) {
            logger.info(`Part ID ${part.partId}: match found for subtitle stream '${subtitleStream.displayTitle}'`)
            partUpdate.subtitleStreamId = subtitleStream.id
            break
          }
        }
      }
      else {
        logger.info(`Part ID ${part.partId}: only one subtitle stream present. Skipping`)
      }

      if (!partUpdate.audioStreamId) logger.info(`Part ID ${part.partId}: no match found for subtitle streams. Skipping`)

      streamsToUpdate.push(partUpdate)
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
    const tokens = config.groups[group] || []
    if (tokens.length === 0) throw new Error("No groups found in config. Aborting update")

    await Promise.all(
      tokens.flatMap((token) =>
        newStreams.map((stream) => {
          const audioStream = stream.audioStreamId ? `audioStreamID=${stream.audioStreamId}` : ''
          const subtitleStream = stream.subtitleStreamId ? `${audioStream.length > 0 ? '&' : ''}subtitleStreamID=${stream.subtitleStreamId}` :''
          axiosInstance
            .post(`/library/parts/${stream.partId}?${audioStream}${subtitleStream}`, {}, { headers: { "X-Plex-Token": token } })
            .then((response) => logger.info(
              `Update${audioStream ? ` Audio ID ${stream.audioStreamId}`:''}${subtitleStream ? `${audioStream ? ' and':''} Subtitle ID ${stream.subtitleStreamId}`:''} for group ${group}: ${response.status === 200 ? 'SUCCESS' : 'FAIL'}`
            ))
            .catch((error) => logger.error(`Error posting update for group ${group}: ${error.message}`))
        }
        )
      )
    )
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
