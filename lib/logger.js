const fs = require('fs');
const path = require('path');

// Enhanced logger with file logging for requests and responses
class Logger {
    constructor(config) {
        this.config = config;
        
        // Simple color codes
        this.colors = {
            red: '\x1b[31m',     // Failed/Error
            green: '\x1b[32m',   // Success
            yellow: '\x1b[33m',  // Pending/Warning
            blue: '\x1b[34m',    // Info
            reset: '\x1b[0m'     // Reset color
        };
        
        // Initialize file logging if enabled
        if (this.config.fileLogging) {
            this.initializeFileLogging();
        }
    }
    
    initializeFileLogging() {
        // Create logs directory if it doesn't exist
        this.logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
        
        // Create log file with timestamp
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
        this.logFile = path.join(this.logsDir, `requests-${dateStr}.log`);
        
        // Write initial log entry
        this.writeToFile(`\n=== Server started at ${now.toISOString()} ===\n`);
    }
    
    writeToFile(message) {
        if (!this.config.fileLogging || !this.logFile) {
            return;
        }
        
        try {
            fs.appendFileSync(this.logFile, message);
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        }
    }
    
    logRequestData(req, requestId = this.generateRequestId()) {
        if (!this.config.fileLogging) {
            return requestId;
        }
        
        const timestamp = new Date().toISOString();
        
        // Add separator for new API call
        this.writeToFile(`\n${'='.repeat(80)}\n`);
        this.writeToFile(`API CALL ${requestId} - ${timestamp}\n`);
        this.writeToFile(`${'='.repeat(80)}\n`);
        
        const logEntry = {
            timestamp,
            requestId,
            type: 'REQUEST',
            method: req.method,
            url: req.url,
            headers: this.sanitizeHeaders(req.headers),
            body: req.body || null,
            query: req.query || null
        };
        
        this.writeToFile(`${JSON.stringify(logEntry, null, 2)}\n`);
        return requestId;
    }
    
    logResponseData(res, responseData, requestId) {
        if (!this.config.fileLogging) {
            return;
        }
        
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            requestId,
            type: 'RESPONSE',
            statusCode: res.statusCode,
            headers: this.sanitizeHeaders(res.getHeaders()),
            body: responseData || null
        };
        
        this.writeToFile(`${JSON.stringify(logEntry, null, 2)}\n`);
    }
    
    sanitizeHeaders(headers) {
        const sanitized = { ...headers };
        // Remove sensitive headers
        if (sanitized.authorization) {
            sanitized.authorization = '[REDACTED]';
        }
        if (sanitized.cookie) {
            sanitized.cookie = '[REDACTED]';
        }
        return sanitized;
    }
    
    generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }
    
    logClaudeInteraction(prompt, claudeResponse, requestId, isStreaming = false) {
        if (!this.config.fileLogging) {
            return;
        }
        
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            requestId,
            type: 'CLAUDE_INTERACTION',
            isStreaming,
            prompt: {
                text: prompt,
                length: prompt ? prompt.length : 0
            },
            response: {
                text: claudeResponse,
                length: claudeResponse ? claudeResponse.length : 0
            }
        };
        
        this.writeToFile(`${JSON.stringify(logEntry, null, 2)}\n`);
    }

    // Simple API request logging with colors
    logRequest(req, res, startTime) {
        const duration = Date.now() - startTime;
        const method = req.method;
        const url = req.url;
        const statusCode = res.statusCode;
        
        if (statusCode >= 500) {
            // Server errors - red
            console.log(`${this.colors.red}API failed: ${method} ${url} ${statusCode} - ${duration}ms${this.colors.reset}`);
        } else if (statusCode >= 400) {
            // Client errors - red
            console.log(`${this.colors.red}API failed: ${method} ${url} ${statusCode} - ${duration}ms${this.colors.reset}`);
        } else if (statusCode >= 300) {
            // Redirects - yellow
            console.log(`${this.colors.yellow}API redirect: ${method} ${url} ${statusCode} - ${duration}ms${this.colors.reset}`);
        } else {
            // Success - green
            console.log(`${this.colors.green}API success: ${method} ${url} ${statusCode} - ${duration}ms${this.colors.reset}`);
        }
    }

    // Simple error logging with red color
    logError(error, context = '') {
        const contextStr = context ? ` [${context}]` : '';
        console.log(`${this.colors.red}API failed${contextStr}: ${error.message || error}${this.colors.reset}`);
    }

    // Compatibility methods - just use console.log
    info(message, ...args) {
        console.log(`${this.colors.blue}INFO:${this.colors.reset}`, message, ...args);
    }

    error(message, ...args) {
        console.log(`${this.colors.red}ERROR:${this.colors.reset}`, message, ...args);
    }

    warn(message, ...args) {
        console.log(`${this.colors.yellow}WARN:${this.colors.reset}`, message, ...args);
    }

    debug(message, ...args) {
        // Only show debug messages if debug mode is enabled
        if (this.config.debugMode) {
            console.log(`${this.colors.blue}DEBUG:${this.colors.reset}`, message, ...args);
        }
    }

    // Stub methods for compatibility with existing code
    logPerformance() {}
    logClaudeInteraction() {}
    logSession() {}
    logRateLimit() {}
    logAuth() {}
}

module.exports = Logger;