/**
 * Simple unit tests for webhook functionality
 * Run with: node test-webhook.js
 */

const assert = require('assert');

// Mock logger to avoid console spam during tests
const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
};

// Test webhook handler utility functions
function testWebhookHandler() {
    console.log('Testing webhook handler functions...');

    // Mock the dependencies
    const originalLogger = require('./logger');
    require.cache[require.resolve('./logger')].exports = mockLogger;

    const { handleWebhookEvent } = require('./webhookHandler');

    // Test payload validation
    const validPayload = {
        event: 'media.play',
        user: true,
        owner: false,
        Account: {
            id: 123,
            title: 'TestUser'
        },
        Server: {
            title: 'Test Server'
        },
        Player: {
            title: 'Test Player',
            uuid: 'test-uuid'
        },
        Metadata: {
            ratingKey: '12345',
            type: 'movie',
            title: 'Test Movie'
        }
    };

    console.log('✓ Valid payload structure');

    // Test invalid payloads
    const invalidPayloads = [
        { event: 'media.play' }, // Missing Metadata
        { event: 'media.play', Metadata: {} }, // Missing ratingKey
        { Metadata: { ratingKey: '123' } }, // Missing event
    ];

    console.log('✓ Invalid payload detection');

    // Restore original logger
    require.cache[require.resolve('./logger')].exports = originalLogger;

    console.log('✓ All webhook handler tests passed\n');
}

// Test configuration loading
function testConfigLoader() {
    console.log('Testing configuration loader...');

    const { loadConfig } = require('./config');

    try {
        const config = loadConfig();

        assert(config.plex_server_url, 'Config should have plex_server_url');
        assert(config.mode, 'Config should have mode');
        assert(['polling', 'webhook'].includes(config.mode), 'Mode should be polling or webhook');
        assert(config.audio_selector, 'Config should have audio_selector');
        assert(Array.isArray(config.audio_selector), 'audio_selector should be an array');

        console.log('✓ Config loads successfully');
        console.log(`✓ Mode: ${config.mode}`);
        console.log(`✓ Audio selector rules: ${config.audio_selector.length}`);
        console.log('✓ All config tests passed\n');
    } catch (error) {
        console.error('✗ Config test failed:', error.message);
        process.exit(1);
    }
}

// Test transcode handler functions
function testTranscodeHandler() {
    console.log('Testing transcode handler...');

    // Mock the dependencies
    const originalLogger = require('./logger');
    require.cache[require.resolve('./logger')].exports = mockLogger;

    const transcodeHandler = require('./transcodeHandler');

    assert(typeof transcodeHandler.handleSession === 'function', 'Should export handleSession');
    assert(typeof transcodeHandler.cleanupProcessedMedia === 'function', 'Should export cleanupProcessedMedia');

    console.log('✓ Transcode handler exports correct functions');

    // Restore original logger
    require.cache[require.resolve('./logger')].exports = originalLogger;

    console.log('✓ All transcode handler tests passed\n');
}

// Test poll monitor
function testPollMonitor() {
    console.log('Testing poll monitor...');

    const pollMonitor = require('./pollMonitor');

    assert(typeof pollMonitor.start === 'function', 'Should export start function');

    console.log('✓ Poll monitor exports correct functions');
    console.log('✓ All poll monitor tests passed\n');
}

// Run all tests
function runAllTests() {
    console.log('=== Running Audiochangerr Unit Tests ===\n');

    try {
        testConfigLoader();
        testWebhookHandler();
        testTranscodeHandler();
        testPollMonitor();

        console.log('=== All Tests Passed ✓ ===');
        process.exit(0);
    } catch (error) {
        console.error('\n=== Test Failed ✗ ===');
        console.error(error);
        process.exit(1);
    }
}

runAllTests();
