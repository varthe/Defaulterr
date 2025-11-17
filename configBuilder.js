const fs = require("fs")
const yaml = require("js-yaml")
const logger = require("./logger")
const Ajv = require("ajv")
const ajv = new Ajv()

// Path to YAML file
const yamlFilePath = process.argv[3] || "./config.yaml"

// Define the updated validation schema
const schema = {
    type: "object",
    properties: {
        plex_server_url: { type: "string", minLength: 1 },
        plex_token: { type: "string" },
        owner_username: { type: "string" },
        check_interval: { type: "number", minimum: 1 },
        dry_run: { type: "boolean" },
        mode: { type: "string", enum: ["polling", "webhook"] },
        webhook_port: { type: "integer", minimum: 1, maximum: 65535 },
        audio_selector: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    codec: { type: "string" },
                    channels: { type: "integer", minimum: 1 },
                    language: { type: "string" },
                    keywords_include: {
                        type: "array",
                        items: { type: "string" }
                    },
                    keywords_exclude: {
                        type: "array",
                        items: { type: "string" }
                    }
                },
                additionalProperties: false
            }
        }
    },
    required: ["plex_server_url", "audio_selector"],
    additionalProperties: false,
}

const formatErrors = (errors) => {
    return errors.map((error) => `"${error.instancePath}": ${error.message || "Validation error"}`).join("\n")
}

const normalizeUrl = (url) => (url.endsWith("/") ? url.slice(0, -1) : url)

// Function to load and validate YAML
const loadAndValidateYAML = () => {
    try {
        // Read and parse the YAML file
        const fileContent = fs.readFileSync(yamlFilePath, "utf8")
        const jsonData = yaml.load(fileContent)

        // Validate the JSON data against the schema
        const validate = ajv.compile(schema)
        const isValid = validate(jsonData)

        if (!isValid) throw new Error(`\n${formatErrors(validate.errors)}`)

        logger.info("Validated and loaded config file")
        jsonData.plex_server_url = normalizeUrl(jsonData.plex_server_url)
        return jsonData
    } catch (error) {
        logger.error(`Error loading or validating YAML: ${error.message}`)
        process.exit(1)
    }
}

module.exports = loadAndValidateYAML
