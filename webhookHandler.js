const logger = require('./logger');
const plexClient = require('./plexClient');
const transcodeHandler = require('./transcodeHandler');

// Events we care about (from official Plex docs)
const RELEVANT_EVENTS = ['media.play', 'playback.started'];

// Track concurrent processing to prevent race conditions
const activeProcessing = new Set();

async function handleWebhookEvent(payload, config) {
    const { event, user, owner, Account, Server, Player, Metadata } = payload;

    // Log event details
    logger.debug(`Event: ${event}, User flag: ${user}, Owner flag: ${owner}`);

    // Filter events early
    if (!RELEVANT_EVENTS.includes(event)) {
        logger.debug(`Ignoring event: ${event}`);
        return;
    }

    // Validate payload structure (fail fast)
    try {
        validatePayload(payload);
    } catch (error) {
        logger.error(`Webhook validation failed: ${error.message}`);
        logger.debug(`Payload: ${JSON.stringify(payload, null, 2)}`);
        throw error;
    }

    // Log who triggered this
    const username = Account?.title || 'Unknown';
    const playerName = Player?.title || 'Unknown Player';
    const mediaTitle = getMediaTitle(Metadata);

    logger.info(`${event}: "${mediaTitle}" - User: ${username}, Player: ${playerName}`);

    // Log server info for debugging
    logger.debug(`Server: ${Server?.title}, Local: ${Player?.local}`);

    // Create unique processing ID to prevent concurrent processing
    const processingId = `${Metadata.ratingKey}-${Account?.id || 'unknown'}`;

    if (activeProcessing.has(processingId)) {
        logger.debug(`Already processing webhook for ${processingId}, skipping duplicate`);
        return;
    }

    activeProcessing.add(processingId);

    try {
        // Webhooks don't include transcode status - must fetch session
        // We need to fetch sessions and match by ratingKey + user
        const sessions = await plexClient.fetchSessions();

        if (sessions.length === 0) {
            logger.debug('No active sessions found');
            return;
        }

        // Find matching session by ratingKey and user
        const session = findMatchingSession(sessions, Metadata, Account, Player);

        if (!session) {
            logger.warn(`No matching session found for ${mediaTitle}`);
            logger.debug(`Searched ${sessions.length} active sessions`);
            logger.debug(`Looking for ratingKey: ${Metadata.ratingKey}, user: ${username}`);
            return;
        }

        logger.debug(`Found session: ${session.Session?.id || 'unknown'}`);
        logger.debug(`Transcoding: ${session.TranscodeSession ? 'YES' : 'NO'}`);

        // Delegate to shared transcode handler
        await transcodeHandler.handleSession(session, config);

    } catch (error) {
        logger.error(`Error processing webhook event: ${error.message}`);
        logger.error(error.stack);
        throw error;
    } finally {
        activeProcessing.delete(processingId);
    }
}

function validatePayload(payload) {
    if (!payload.event) {
        throw new Error('Webhook missing event field');
    }

    if (!payload.Metadata) {
        throw new Error('Webhook missing Metadata');
    }

    if (!payload.Metadata.ratingKey) {
        throw new Error('Webhook missing Metadata.ratingKey');
    }

    if (!payload.Account) {
        logger.warn('Webhook missing Account information');
    }

    if (!payload.Player) {
        logger.warn('Webhook missing Player information');
    }
}

function getMediaTitle(metadata) {
    if (!metadata) return 'Unknown';

    // Handle different media types
    switch (metadata.type) {
        case 'movie':
            return metadata.title;
        case 'episode':
            return `${metadata.grandparentTitle} - ${metadata.title}`;
        case 'track':
            return `${metadata.grandparentTitle} - ${metadata.title}`;
        default:
            return metadata.title || 'Unknown';
    }
}

function findMatchingSession(sessions, metadata, account, player) {
    // Match by ratingKey first (most reliable)
    const candidates = sessions.filter(s =>
        String(s.ratingKey) === String(metadata.ratingKey)
    );

    if (candidates.length === 0) {
        return null;
    }

    if (candidates.length === 1) {
        return candidates[0];
    }

    // Multiple sessions for same media - narrow down by user/player
    logger.debug(`Multiple sessions for ratingKey ${metadata.ratingKey}, narrowing by user/player`);

    // Try to match by user ID
    if (account?.id) {
        const userMatch = candidates.find(s =>
            String(s.User?.id) === String(account.id)
        );
        if (userMatch) return userMatch;
    }

    // Try to match by player UUID
    if (player?.uuid) {
        const playerMatch = candidates.find(s =>
            s.Player?.uuid === player.uuid
        );
        if (playerMatch) return playerMatch;
    }

    // Fallback to first candidate (best effort)
    logger.warn(`Could not uniquely identify session, using first match`);
    return candidates[0];
}

module.exports = { handleWebhookEvent };
