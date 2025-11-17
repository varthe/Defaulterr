const express = require('express');
const multer = require('multer');
const logger = require('./logger');

function startWebhookServer(port, onEvent) {
    const app = express();
    const upload = multer(); // For parsing multipart/form-data

    let webhookCount = 0;
    let lastWebhookTime = null;

    // Webhook endpoint - matches Plex multipart format
    app.post('/webhook', upload.none(), (req, res) => {
        try {
            // Plex sends JSON in 'payload' field of multipart form
            if (!req.body.payload) {
                logger.error('Webhook received without payload field');
                logger.debug(`Request body: ${JSON.stringify(req.body)}`);
                return res.status(400).send('Bad Request: missing payload');
            }

            const payload = JSON.parse(req.body.payload);
            webhookCount++;
            lastWebhookTime = new Date().toISOString();

            logger.info(`Webhook received: ${payload.event}`);
            logger.debug(`Webhook ${webhookCount}: ${payload.event} - ${payload.Metadata?.title || 'Unknown'}`);

            // Respond immediately to Plex (important!)
            res.status(200).send('OK');

            // Process asynchronously
            if (onEvent) {
                onEvent(payload);
            }

        } catch (error) {
            logger.error(`Webhook parse error: ${error.message}`);
            logger.debug(`Request body: ${JSON.stringify(req.body)}`);
            res.status(400).send('Bad Request');
        }
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            uptime: Math.floor(process.uptime()),
            webhooksReceived: webhookCount,
            lastWebhook: lastWebhookTime,
            message: webhookCount === 0 ? 'No webhooks received yet. Check Plex configuration.' : 'Receiving webhooks'
        });
    });

    // Root endpoint for quick check
    app.get('/', (req, res) => {
        res.send('Audiochangerr Webhook Server - Ready');
    });

    const server = app.listen(port, '0.0.0.0', () => {
        logger.info(`Webhook server listening on port ${port}`);
        logger.info(`Configure Plex webhook URL: http://YOUR_SERVER_IP:${port}/webhook`);
        logger.info(`Health check available at: http://localhost:${port}/health`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM received, closing webhook server');
        server.close(() => {
            logger.info('Webhook server closed');
        });
    });

    process.on('SIGINT', () => {
        logger.info('SIGINT received, closing webhook server');
        server.close(() => {
            logger.info('Webhook server closed');
            process.exit(0);
        });
    });

    return server;
}

module.exports = { startWebhookServer };
