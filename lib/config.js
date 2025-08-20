const os = require('os');
const path = require('path');
const fs = require('fs');

class Config {
    constructor() {
        this.loadEnv();
        this.loadConfig();
    }

    loadEnv() {
        // Load .env file if it exists
        const envPath = path.join(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const lines = envContent.split('\n');
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith('#')) {
                    const [key, value] = trimmedLine.split('=', 2);
                    if (key && value !== undefined) {
                        process.env[key.trim()] = value.trim();
                    }
                }
            }
        }
    }

    loadConfig() {
        // Only configuration we need: PORT
        this.port = parseInt(process.env.PORT || '8000', 10);
        
        // Debug and logging configuration
        this.debugMode = process.env.DEBUG === 'true';
        this.fileLogging = process.env.FILE_LOGGING === 'true';
        
        // Fixed defaults - no environment configuration needed
        this.host = '0.0.0.0';
        this.claudeCliPath = this.getClaudeCliPath();
        this.claudeCwd = process.cwd();
        this.corsOrigins = ['*']; // Always allow all origins
        this.logLevel = 'info';
        
        // No hardcoded models - let Claude CLI determine what's available
        
        this.validateConfig();
    }

    getClaudeCliPath() {
        // On Windows, Node.js spawn requires the full executable name
        if (process.platform === 'win32') {
            return 'claude.cmd';
        }
        return 'claude';
    }

    validateConfig() {
        // Only validate port
        if (this.port < 1 || this.port > 65535) {
            throw new Error(`Invalid port: ${this.port}. Must be between 1 and 65535.`);
        }
    }

    getClaudeEnvVars() {
        // Return current environment variables for Claude CLI
        return process.env;
    }

    isDebugEnabled() {
        return this.debugMode;
    }

    toString() {
        const safeConfig = { ...this };
        
        // Hide sensitive information
        if (safeConfig.apiKey) safeConfig.apiKey = '***';
        if (safeConfig.anthropicApiKey) safeConfig.anthropicApiKey = '***';
        if (safeConfig.awsSecretAccessKey) safeConfig.awsSecretAccessKey = '***';
        
        return JSON.stringify(safeConfig, null, 2);
    }
}

module.exports = Config;