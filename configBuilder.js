const fs = require('fs')
const yaml = require('js-yaml')
const logger = require('./logger')
const Ajv = require('ajv')
const ajv = new Ajv()

const yamlFilePath = process.argv[2] || './config.yaml';
// Define the validation schema
const schema = {
  type: 'object',
  properties: {
    plex_url: { type: 'string' },
    plex_owner_token: { type: 'string' },
    dry_run: { type: 'boolean' },
    full_run_on_start: { type: 'boolean' },
    full_run_cron_expression: {type: 'string'},
    groups: {
      type: 'object',
      patternProperties: {
        ".*": {  // Matches arbitrary group names like "serialTranscoders" and "weebs"
          type: 'array',
          items: { type: 'string' } // Each group is an array of tokens (strings)
        }
      },
      additionalProperties: false
    },
    filters: {
      type: 'object',
      patternProperties: {
        ".*": {  // Matches arbitrary library names like "Movies - 1080p" or "Anime"
          type: 'object',
          patternProperties: {
            ".*": {  // Matches arbitrary group names like "serialTranscoders" or "weebs"
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  include: {
                    type: 'object',
                    additionalProperties: true // Allow any properties inside 'include'
                  },
                  exclude: {
                    type: 'object',
                    additionalProperties: true // Allow any properties inside 'exclude'
                  }
                },
                additionalProperties: false // Prevent additional properties outside 'include' and 'exclude'
              }
            }
          }
        }
      }
    }
  },
  required: ['plex_url', 'plex_owner_token', 'groups', 'filters'],
  additionalProperties: false
}

// Function to load and validate YAML
const loadAndValidateYAML = () => {
  try {
    // Read and parse the YAML file
    const fileContent = fs.readFileSync(yamlFilePath, 'utf8')
    const jsonData = yaml.load(fileContent)

    // Validate the JSON data against the schema
    const validate = ajv.compile(schema)
    const isValid = validate(jsonData)

    if (isValid) {
      logger.info("YAML file is valid according to the schema.");
      return jsonData
    } 
    throw new Error(`Validation errors: ${JSON.stringify(validate.errors)}`)

  } catch (error) {
    logger.error(`Error loading or validating YAML: ${error.message}`)
    process.exit(1)
  }
};

module.exports = loadAndValidateYAML