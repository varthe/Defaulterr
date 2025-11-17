const loadAndValidateYAML = require('./configBuilder');

function loadConfig() {
    return loadAndValidateYAML();
}

module.exports = { loadConfig };
