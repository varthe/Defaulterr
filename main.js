const express = require("express")
const fs = require("fs")
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
const timestampsFile = process.argv[4] || "./last_run_timestamps.json"

// Create an Axios instance with increased timeout and keep-alive
const axiosInstance = axios.create({
    baseURL: config.plex_server_url,
    headers: {
        "X-Plex-Token": config.plex_owner_token,
    },
    timeout: 600000,
})

// Utility to handle error logging
const handleAxiosError = (context, error) => {
    if (error.response) {
        logger.error(`Error ${context}: ${error.response.status} - ${error.response.statusText}`)
    } else if (error.request) {
        logger.error(`Error ${context}: No response received.`)
    } else {
        logger.error(`Error ${context}: ${error.message}`)
    }
}

// Function to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Function to parse user details from XML
const getUserDetailsFromXml = async (xml) => {
    const parser = new xml2js.Parser()
    try {
        const result = await parser.parseStringPromise(xml)
        const sharedServers = result.MediaContainer.SharedServer || []
        const extractedData = sharedServers.map((server) => {
            const username = server.$.username
            const accessToken = server.$.accessToken
            return { username, accessToken }
        })
        return extractedData
    } catch (error) {
        throw new Error(`Error parsing XML: ${error.message}`)
    }
}

// Fetch all users listed in filters
const fetchAllUsersListedInFilters = async () => {
    try {
        if (!config.plex_client_identifier) throw new Error("Client identifier not supplied in config")
        const response = await axios.get(
            `https://plex.tv/api/servers/${config.plex_client_identifier}/shared_servers`,
            {
                headers: {
                    "X-Plex-Token": config.plex_owner_token,
                    Accept: "application/json",
                },
            }
        )
        const filterUsernames = new Set(Object.values(config.groups).flat())
        const users = await getUserDetailsFromXml(response.data)
        users.forEach((user) => {
            if (filterUsernames.has(user.username) || filterUsernames.has("$ALL")) {
                USERS.set(user.username, user.accessToken)
            }
        })

        const managedUsers = config.managed_users
        if (managedUsers) {
            Object.keys(managedUsers).forEach((user) => {
                const token = managedUsers[user]
                if (user && token) {
                    USERS.set(user, token)
                }
            })
            logger.info(`Finished processing managed users`)
        }
        logger.info("Fetched and stored user details successfully.")
    } catch (error) {
        logger.warn(`Could not fetch users with access to server: ${error.message}`)
        return
    }
}

// Verify each token can access the API endpoint
const fetchUsersWithAccess = async (libraryName) => {
    const { id } = await fetchLibraryDetailsByName(libraryName)
    const usersWithAccess = new Map()
    const groups = config.filters[libraryName]

    for (const group in groups) {
        let usernames = config.groups[group]
        let users = []
        if (usernames.includes("$ALL")) {
            usernames = [...USERS.keys()]
        }
        for (const username of usernames) {
            const token = USERS.get(username)
            try {
                const response = await axios.get(`${config.plex_server_url}/library/sections/${id}`, {
                    headers: { "X-Plex-Token": token },
                })
                if (response.status !== 200) throw new Error(`Unexpected response status: ${response.status}`)
                logger.debug(
                    `Checking if user ${username} of group ${group} has access to library ${libraryName}... OK`
                )
                users.push(username)
            } catch (error) {
                logger.warn(
                    `User ${username} of group ${group} can't access library ${libraryName}. They will be skipped during updates. ${error.message}`
                )
            }
            await delay(100)
        }
        usersWithAccess.set(group, users)
    }
    return usersWithAccess
}

// Setup Cron Job
const setupCronJob = () => {
    if (config.dry_run || !config.partial_run_cron_expression) return
    if (!cronValidator.isValidCron(config.partial_run_cron_expression))
        throw new Error(`Invalid cron expression: ${config.partial_run_cron_expression}`)
    cron.schedule(config.partial_run_cron_expression, async () => {
        logger.info(`Running scheduled partial run at ${new Date().toISOString()}`)
        await performPartialRun()
    })
    logger.info("Cron job set up successfully")
}

// Fetch all libraries and map by ID
const fetchAllLibraries = async () => {
    try {
        const { data } = await axiosInstance.get("/library/sections").catch(async (error) => {
            logger.error(`Error fetching libraries: ${error.message}. Retrying in 30 sec...`)
            let res = error.response
            let attempt = 1
            await delay(30000)
            while (res.status !== 200 && attempt < 10) {
                await axiosInstance
                    .get("/library/sections")
                    .then((response) => (res = response))
                    .catch((error) => {
                        logger.error(
                            `Attempt ${attempt}/10 failed with error: ${error.message}. Retrying in 30 sec... `
                        )
                    })

                if (res.status === 200) return res

                attempt++
                await delay(30000)
            }
            logger.error(`All attempts failed. Verify connection to Plex before restarting. Shutting down.`)
            process.exit(1)
        })
        const libraries = data?.MediaContainer?.Directory || []

        for (const libraryName in config.filters) {
            const library = libraries.find((lib) => lib.title.toLowerCase() === libraryName.toLowerCase())
            if (!library) throw new Error(`Library '${libraryName}' not found in Plex response`)
            if (library.type !== "movie" && library.type !== "show")
                throw new Error(`Invalid library type '${library.type}'. Must be 'movie' or 'show'`)

            LIBRARIES.set(library.key, { name: library.title, type: library.type })
            logger.debug(`Mapped library: ${library.title} (ID: ${library.key}, Type: ${library.type})`)
        }

        logger.info("Fetched and mapped libraries")
    } catch (error) {
        handleAxiosError("fetching libraries", error)
    }
}

// Load last run timestamps from the file
const loadLastRunTimestamps = () => {
    if (fs.existsSync(timestampsFile)) {
        const data = fs.readFileSync(timestampsFile, "utf-8")
        return JSON.parse(data)
    }
    return {}
}

// Save the new last run timestamps to the file
const saveLastRunTimestamps = (timestamps) => {
    fs.writeFileSync(timestampsFile, JSON.stringify(timestamps, null, 2), "utf-8")
}

// Fetch media items that were updated after a specific timestamp
const fetchUpdatedMediaItems = async (libraryId, lastUpdatedAt) => {
    try {
        const { data } = await axiosInstance.get(`/library/sections/${libraryId}/all`)
        const items = data?.MediaContainer?.Metadata || []

        // Filter items updated after the last known updatedAt timestamp
        return items.filter((item) => item.updatedAt > lastUpdatedAt)
    } catch (error) {
        handleAxiosError(`fetching updated media for Library ID ${libraryId}`, error)
        return []
    }
}

const evaluateStreams = (streams, filters) => {
    for (const filter of Object.values(filters)) {
        const { include, exclude } = filter

        const defaultStream = streams.find((stream) => {
            // Check 'include' first
            if (
                include &&
                Object.entries(include).some(([field, value]) => {
                    const streamValue = stream[field]?.toString().toLowerCase()
                    if (!streamValue) return true
                    const valuesArray = Array.isArray(value) ? value : [value]
                    return valuesArray.some((value) => !streamValue.includes(value.toString().toLowerCase()))
                })
            ) {
                return false
            }

            // Check 'exclude'
            if (
                exclude &&
                Object.entries(exclude).some(([field, value]) => {
                    const streamValue = stream[field]?.toString().toLowerCase()
                    if (!streamValue) return false
                    const valuesArray = Array.isArray(value) ? value : [value]
                    return valuesArray.some((value) => streamValue.includes(value.toString().toLowerCase()))
                })
            ) {
                return false
            }

            return true
        })

        if (defaultStream)
            return {
                id: defaultStream.id,
                extendedDisplayTitle: defaultStream.extendedDisplayTitle,
                onMatch: filter.on_match || {},
            }
    }
}

// Fetch streams for a specific media item (movie or episode)
const fetchStreamsForItem = async (itemId) => {
    try {
        const { data } = await axiosInstance.get(`/library/metadata/${itemId}`)
        const part = data?.MediaContainer?.Metadata[0]?.Media[0]?.Part[0]
        if (!part || !part.id || !part.Stream) {
            logger.warn(`Item ID ${itemId} has invalid media structure. Skipping.`)
            return { partId: itemId, streams: [] }
        }
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
        // Fetch streams for each episode sequentially
        const streams = []
        for (const episode of episodes) {
            const stream = await fetchStreamsForItem(episode.ratingKey)
            streams.push(stream)
            // Optional: Delay between fetching each episode to reduce load
            await delay(100)
        }
        return streams
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
            logger.warn(`No seasons found for Show ID ${showId}`)
            return []
        }
        const streams = []
        for (const season of seasons) {
            const seasonStreams = await fetchStreamsForSeason(season.ratingKey)
            streams.push(...seasonStreams)
            // Optional: Delay between fetching each season to reduce load
            await delay(100) // 100ms delay
        }
        return streams
    } catch (error) {
        handleAxiosError(`fetching seasons for Show ID ${showId}`, error)
        return []
    }
}

// Fetch library details by its name
const fetchLibraryDetailsByName = async (libraryName) => {
    try {
        for (const [key, details] of LIBRARIES.entries()) {
            if (details.name.toLowerCase() === libraryName.toLowerCase()) {
                return { id: key, type: details.type }
            }
        }
        throw new Error(`Library '${libraryName}' not found`)
    } catch (error) {
        handleAxiosError(`fetching library details for '${libraryName}'`, error)
        return { id: null, type: null }
    }
}

const findMatchingAudioStream = (part, audioFilters) => {
    if (!audioFilters) return

    const audioStreams = part.streams.filter((stream) => stream.streamType === STREAM_TYPES.audio)
    return evaluateStreams(audioStreams, audioFilters)
}

const findMatchingSubtitleStream = (part, subtitleFilters) => {
    if (!subtitleFilters) return
    if (subtitleFilters === "disabled") return { id: 0 }

    const subtitleStreams = part.streams.filter((stream) => stream.streamType === STREAM_TYPES.subtitles)
    return evaluateStreams(subtitleStreams, subtitleFilters)
}

// Determine which streams should be updated based on filters
const identifyStreamsToUpdate = async (parts, filters) => {
    try {
        const streamsToUpdate = []

        for (const part of parts) {
            if (!part.streams || part.streams.length <= 1) {
                logger.info(`Part ID ${part.partId} has only one stream. Skipping.`)
                continue
            }

            const partUpdate = { partId: part.partId }

            let audio = findMatchingAudioStream(part, filters.audio) || {}
            let subtitles = findMatchingSubtitleStream(part, filters.subtitles) || {}

            if (audio?.onMatch?.subtitles) subtitles = findMatchingSubtitleStream(part, audio.onMatch.subtitles)
            if (subtitles?.onMatch?.audio) audio = findMatchingAudioStream(part, subtitles.filter.onMatch.audio)

            if (audio.id) {
                partUpdate.audioStreamId = audio.id
                logger.info(`Part ID ${part.partId}: match found for audio stream ${audio.extendedDisplayTitle}`)
            } else {
                logger.debug(`Part ID ${part.partId}: no match found for audio streams`)
            }
            if (subtitles.id >= 0) {
                partUpdate.subtitleStreamId = subtitles.id
                logger.info(
                    `Part ID ${part.partId}: ${
                        subtitles.id === 0
                            ? "subtitles disabled"
                            : `match found for subtitle stream ${subtitles.extendedDisplayTitle}`
                    }`
                )
            } else {
                logger.debug(`Part ID ${part.partId}: no match found for subtitle streams`)
            }

            if (partUpdate.audioStreamId || partUpdate.subtitleStreamId >= 0) {
                streamsToUpdate.push(partUpdate)
            }
        }
        return streamsToUpdate
    } catch (error) {
        logger.error(`Error while evaluating streams for filter: ${error.message}. Aborting`)
        return []
    }
}

// Update default streams for a single item across all relevant users
const updateDefaultStreamsPerItem = async (streamsToUpdate, filters, users) => {
    for (const group in streamsToUpdate) {
        for (const stream of streamsToUpdate[group]) {
            const usernames = users.get(group)
            if (usernames.length === 0) {
                logger.warn(`No users found in group '${group}'. Skipping update.`)
                continue
            }
            for (const username of usernames) {
                const token = USERS.get(username)
                if (!token) {
                    logger.warn(`No access token found for user ${username}. Skipping update.`)
                    continue
                }
                const queryParams = new URLSearchParams()
                if (stream.audioStreamId) queryParams.append("audioStreamID", stream.audioStreamId)
                if (stream.subtitleStreamId >= 0) queryParams.append("subtitleStreamID", stream.subtitleStreamId)

                try {
                    const response = await axiosInstance
                        .post(
                            `/library/parts/${stream.partId}?${queryParams.toString()}`,
                            {},
                            { headers: { "X-Plex-Token": token } }
                        )
                        .catch(async (error) => {
                            logger.error(
                                `Error while posting update for user ${username} in group ${group}${
                                    error.status === 403
                                        ? ". This could be because of age ratings, ensure they can access ALL items in the library"
                                        : ""
                                }: ${error.message}. Retrying in 30 sec...`
                            )
                            await delay(30000)
                            let responseStatus = ""
                            let attempt = 1
                            while (responseStatus !== 200 && attempt < 10) {
                                await axiosInstance
                                    .post(
                                        `/library/parts/${stream.partId}?${queryParams.toString()}`,
                                        {},
                                        { headers: { "X-Plex-Token": token } }
                                    )
                                    .then((response) => (responseStatus = response.status))
                                    .catch((error) => {
                                        logger.error(
                                            `Attempt ${attempt}/10 failed with error: ${error.message}. Retrying in 30 sec...`
                                        )
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
                        })

                    const audioMessage = stream.audioStreamId ? `Audio ID ${stream.audioStreamId}` : ""
                    const subtitleMessage = stream.subtitleStreamId >= 0 ? `Subtitle ID ${stream.subtitleStreamId}` : ""
                    const updateMessage = [audioMessage, subtitleMessage].filter(Boolean).join(" and ")
                    logger.debug(
                        `Update ${updateMessage} for user ${username} in group ${group}: ${
                            response.status === 200 ? "SUCCESS" : "FAIL"
                        }`
                    )
                } catch (error) {
                    handleAxiosError(`posting update for user '${username}' in group '${group}'`, error)
                }
                await delay(100) // 50ms delay
            }
            logger.info(`Part ID ${stream.partId}: update complete for group ${group}`)
        }
    }
}

// Identify streams for dry run
const identifyStreamsForDryRun = async () => {
    for (const libraryName in config.filters) {
        logger.info(`Processing library for dry run: ${libraryName}`)
        const { id, type } = await fetchLibraryDetailsByName(libraryName)
        if (!id || !type) {
            logger.warn(`Library '${libraryName}' details are incomplete. Skipping.`)
            continue
        }
        const updatedItems = await fetchUpdatedMediaItems(id, 0)

        if (type === "movie") {
            for (const item of updatedItems) {
                const stream = await fetchStreamsForItem(item.ratingKey)
                const groupFilters = config.filters[libraryName]
                const newStreams = {}

                for (const group in groupFilters) {
                    const matchedStreams = await identifyStreamsToUpdate([stream], groupFilters[group])
                    if (matchedStreams.length > 0) {
                        newStreams[group] = matchedStreams
                    }
                }
                await delay(100)
            }
        } else if (type === "show") {
            for (const item of updatedItems) {
                const showStreams = await fetchStreamsForShow(item.ratingKey)
                for (const stream of showStreams) {
                    const groupFilters = config.filters[libraryName]
                    const newStreams = {}

                    for (const group in groupFilters) {
                        const matchedStreams = await identifyStreamsToUpdate([stream], groupFilters[group])
                        if (matchedStreams.length > 0) {
                            newStreams[group] = matchedStreams
                        }
                    }
                    await delay(100)
                }
            }
        }
    }
}

// Dry run to identify streams without applying updates
const performDryRun = async () => {
    await fetchAllLibraries()
    logger.info("STARTING DRY RUN. NO CHANGES WILL BE MADE.")
    await identifyStreamsForDryRun()
    logger.info("DRY RUN COMPLETE.")
}

// Partial run: process items updated since last run
const performPartialRun = async (cleanRun) => {
    await fetchAllLibraries()

    logger.info(`STARTING ${cleanRun ? "CLEAN" : "PARTIAL"} RUN`)

    const lastRunTimestamps = cleanRun ? {} : loadLastRunTimestamps()
    const newTimestamps = {}

    for (const libraryName in config.filters) {
        logger.info(`Processing library: ${libraryName}`)
        const { id, type } = await fetchLibraryDetailsByName(libraryName)
        if (!id || !type) {
            logger.warn(`Library '${libraryName}' details are incomplete. Skipping.`)
            continue
        }
        const lastUpdatedAt = lastRunTimestamps[libraryName] || 0

        // Fetch updated media items based on updatedAt timestamp
        const updatedItems = await fetchUpdatedMediaItems(id, lastUpdatedAt)
        if (!updatedItems || updatedItems.length === 0) {
            logger.info(`No changes detected in library ${libraryName} since the last run`)
            continue
        }

        const usersWithAccess = await fetchUsersWithAccess(libraryName)
        if (![...usersWithAccess.values()].some((users) => users.length > 0)) {
            logger.warn(`No users have access to library ${libraryName}. Skipping`)
            continue
        }

        if (type === "movie") {
            for (const item of updatedItems) {
                const stream = await fetchStreamsForItem(item.ratingKey)
                const groupFilters = config.filters[libraryName]
                const newStreams = {}

                for (const group in groupFilters) {
                    const matchedStreams = await identifyStreamsToUpdate([stream], groupFilters[group])
                    if (matchedStreams.length > 0) {
                        newStreams[group] = matchedStreams
                    }
                }

                if (Object.keys(newStreams).length > 0) {
                    await updateDefaultStreamsPerItem(newStreams, config.filters[libraryName], usersWithAccess)
                }

                // Optional: Delay between processing each item to reduce load
                await delay(100) // 100ms delay
            }
        } else if (type === "show") {
            for (const item of updatedItems) {
                const showStreams = await fetchStreamsForShow(item.ratingKey)
                for (const stream of showStreams) {
                    const groupFilters = config.filters[libraryName]
                    const newStreams = {}

                    for (const group in groupFilters) {
                        const matchedStreams = await identifyStreamsToUpdate([stream], groupFilters[group])
                        if (matchedStreams.length > 0) {
                            newStreams[group] = matchedStreams
                        }
                    }

                    if (Object.keys(newStreams).length > 0) {
                        await updateDefaultStreamsPerItem(newStreams, config.filters[libraryName], usersWithAccess)
                    }

                    // Optional: Delay between processing each stream to reduce load
                    await delay(100) // 100ms delay
                }
            }
        }

        // Update the timestamp for the current library
        const latestUpdatedAt = Math.max(...updatedItems.map((item) => item.updatedAt))
        newTimestamps[libraryName] = latestUpdatedAt
    }

    // Save the updated timestamps for future runs
    if (Object.keys(newTimestamps).length > 0) saveLastRunTimestamps({ ...lastRunTimestamps, ...newTimestamps })

    logger.info(`FINISHED ${cleanRun ? "CLEAN" : "PARTIAL"} RUN`)
}

// Tautulli webhook for new items
app.post("/webhook", async (req, res) => {
    try {
        logger.info("Tautulli webhook received. Processing...")

        const { type, libraryId, mediaId } = req.body
        if (!type || !libraryId || !mediaId) throw new Error("Error getting request body")

        let libraryName = LIBRARIES.get(libraryId)?.name
        if (!libraryName) {
            // This only triggers if something goes wrong in Tautulli/Plex. Quick refresh should fix it.
            logger.info(`Library ID ${libraryId} not found in filters. Attempting library refresh...`)
            await fetchAllLibraries()

            libraryName = LIBRARIES.get(libraryId)?.name
            if (!libraryName) {
                logger.info(`Library ID ${libraryId} not found in filters. Ending request`)
                return res.status(200).send("Event not relevant")
            }
        }

        const usersWithAccess = await fetchUsersWithAccess(libraryName)
        const filters = config.filters[libraryName]

        let streams = [] // Need arrays for identifyStreamsToUpdate
        if (type === "movie" || type === "episode") {
            streams = [await fetchStreamsForItem(mediaId)]
        } else if (type === "show") {
            streams = await fetchStreamsForShow(mediaId)
        } else if (type === "season") {
            streams = await fetchStreamsForSeason(mediaId)
        }
        // else do nothing

        const updates = []
        for (const group in filters) {
            const newStreams = await identifyStreamsToUpdate(streams, filters[group])
            if (!newStreams || newStreams.length === 0) {
                logger.info("Could not find streams to update. Ending request")
                continue
            }
            updates.push({ group, newStreams })
        }

        for (const { group, newStreams } of updates) {
            let usernames = usersWithAccess.get(group)
            if (usernames.length === 0) {
                logger.warn(`No users found in group '${group}'. Skipping update.`)
                continue
            }

            for (const username of usernames) {
                const token = USERS.get(username)
                if (!token) {
                    logger.warn(`No access token found for user '${username}'. Skipping update.`)
                    continue
                }

                for (const stream of newStreams) {
                    const queryParams = new URLSearchParams()
                    if (stream.audioStreamId) queryParams.append("audioStreamID", stream.audioStreamId)
                    if (stream.subtitleStreamId >= 0) queryParams.append("subtitleStreamID", stream.subtitleStreamId)

                    try {
                        const response = await axiosInstance.post(
                            `/library/parts/${stream.partId}?${queryParams.toString()}`,
                            {},
                            { headers: { "X-Plex-Token": token } }
                        )

                        const audioMessage = stream.audioStreamId ? `Audio ID ${stream.audioStreamId}` : ""
                        const subtitleMessage = stream.subtitleStreamId ? `Subtitle ID ${stream.subtitleStreamId}` : ""
                        const updateMessage = [audioMessage, subtitleMessage].filter(Boolean).join(" and ")
                        logger.info(
                            `Update ${updateMessage} for user ${username} in group ${group}: ${
                                response.status === 200 ? "SUCCESS" : "FAIL"
                            }`
                        )
                    } catch (error) {
                        handleAxiosError(`posting update for user '${username}' in group '${group}'`, error)
                    }

                    // Optional: Delay between posting each update to reduce load
                    await delay(100) // 50ms delay
                }
            }
        }

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
        if (config.plex_owner_name) {
            USERS.set(config.plex_owner_name, config.plex_owner_token)
        }
        await fetchAllUsersListedInFilters()
        if (USERS.size === 0) throw new Error("No users with access to libraries detected")

        if (config.dry_run) await performDryRun()
        else if (config.partial_run_on_start) await performPartialRun()
        else if (config.clean_run_on_start) await performPartialRun(config.clean_run_on_start)
        else await fetchAllLibraries()

        setupCronJob()
    } catch (error) {
        logger.error(`Error initializing the application: ${error.message}`)
        process.exit(1)
    }
})
