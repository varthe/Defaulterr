const logger = require('./logger');
const plexClient = require('./plexClient');
const transcodeHandler = require('./transcodeHandler');

function findTranscodes(sessions) {
    return sessions.filter(session => session.TranscodeSession);
}

function start(config) {
    logger.info('Starting polling monitor');
    logger.info(`Check interval: ${config.check_interval} seconds`);

    setInterval(async () => {
        try {
            const sessions = await plexClient.fetchSessions();
            logger.info(`Active sessions: ${sessions.length}`);

            const transcodeSessions = findTranscodes(sessions);

            if (transcodeSessions.length > 0) {
                logger.info(`Found ${transcodeSessions.length} transcode session(s)`);
                for (const session of transcodeSessions) {
                    await transcodeHandler.handleSession(session, config);
                }
            }

            transcodeHandler.cleanupProcessedMedia(sessions);

        } catch (error) {
            logger.error(`Polling loop error: ${error.message}`);
        }
    }, config.check_interval * 1000);
}

module.exports = { start };
