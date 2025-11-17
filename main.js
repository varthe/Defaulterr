const logger = require('./logger');
const { loadConfig } = require('./config');
const plexClient = require('./plexClient');

async function main() {
    try {
        const config = loadConfig();
        logger.info('Config loaded.');
        logger.info(`Mode: ${config.dry_run ? 'Dry Run' : 'Live'}`);
        logger.info(`Integration: ${config.mode}`);

        plexClient.init(config);

        if (config.mode === 'webhook') {
            // Webhook mode
            logger.info('Starting in WEBHOOK mode');
            logger.warn('⚠️  REQUIREMENT: Webhooks require active Plex Pass subscription');
            logger.warn('⚠️  Configure webhook in Plex Web App: Settings > Account > Webhooks');

            const { startWebhookServer } = require('./webhookServer');
            const { handleWebhookEvent } = require('./webhookHandler');

            startWebhookServer(config.webhook_port, (payload) => {
                handleWebhookEvent(payload, config).catch(err => {
                    logger.error(`Webhook event processing failed: ${err.message}`);
                    logger.error(err.stack);
                });
            });

            // Warn if no webhooks received after 60 seconds
            setTimeout(() => {
                logger.warn('No webhooks received in 60 seconds. Verify:');
                logger.warn(`  1. Plex Pass subscription is active`);
                logger.warn(`  2. Webhook configured: http://YOUR_IP:${config.webhook_port}/webhook`);
                logger.warn(`  3. Firewall allows port ${config.webhook_port}`);
                logger.warn(`  4. Trigger playback to test webhook`);
            }, 60000);

        } else if (config.mode === 'polling') {
            // Polling mode
            logger.info('Starting in POLLING mode');
            const pollMonitor = require('./pollMonitor');
            pollMonitor.start(config);

        } else {
            throw new Error(`Invalid mode: ${config.mode}. Must be "polling" or "webhook"`);
        }

    } catch (error) {
        logger.error(`Failed to start: ${error.message}`);
        logger.error(error.stack);
        process.exit(1);
    }
}

main();
