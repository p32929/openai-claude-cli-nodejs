const { OpenAIModels } = require('./models');

class StreamingResponse {
    constructor(res, request, logger) {
        this.res = res;
        this.request = request;
        this.logger = logger;
        this.closed = false;
        this.sentData = false;
        
        this.setupHeaders();
        this.setupCleanup();
    }

    setupHeaders() {
        // Set headers for Server-Sent Events
        this.res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });
    }

    setupCleanup() {
        // Handle client disconnect
        this.res.on('close', () => {
            this.closed = true;
            this.logger.debug('SSE connection closed by client');
        });

        this.res.on('error', (error) => {
            this.closed = true;
            this.logger.error('SSE connection error:', error);
        });
    }

    write(data) {
        if (this.closed) {
            return false;
        }

        try {
            this.res.write(`data: ${JSON.stringify(data)}\n\n`);
            this.sentData = true;
            return true;
        } catch (error) {
            this.logger.error('Error writing SSE data:', error);
            this.closed = true;
            return false;
        }
    }

    writeChunk(delta, finishReason = null) {
        const chunk = OpenAIModels.createStreamingChunk(this.request, delta, finishReason);
        return this.write(chunk);
    }

    writeError(error) {
        const errorData = {
            error: {
                message: error.message,
                type: error.type || 'streaming_error',
                code: error.code || 'error'
            }
        };
        return this.write(errorData);
    }

    end() {
        if (this.closed) {
            return;
        }

        try {
            // Send [DONE] marker
            this.res.write('data: [DONE]\n\n');
            this.res.end();
            this.closed = true;
            this.logger.debug('SSE stream ended');
        } catch (error) {
            this.logger.error('Error ending SSE stream:', error);
        }
    }

    isClosed() {
        return this.closed;
    }

    hasSentData() {
        return this.sentData;
    }
}

class StreamingManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    createStream(res, request) {
        return new StreamingResponse(res, request, this.logger);
    }

    async processClaudeStream(claudeStream, stream, contentCallback = null) {
        let roleSent = false;
        let contentSent = false;
        let assistantContent = '';
        let chunkCount = 0;

        try {
            this.logger.debug('Starting Claude stream processing...');
            
            for await (const chunk of claudeStream) {
                chunkCount++;
                this.logger.debug(`Processing chunk ${chunkCount}:`, { chunk });
                
                // Check if client disconnected
                if (stream.isClosed()) {
                    this.logger.debug('Client disconnected, stopping Claude stream');
                    break;
                }

                // Parse Claude output
                const parsedChunk = this.parseClaudeChunk(chunk);
                this.logger.debug('Parsed chunk:', parsedChunk);
                
                if (parsedChunk.type === 'assistant_message') {
                    // Send role chunk if not sent yet
                    if (!roleSent) {
                        this.logger.debug('Sending role chunk');
                        stream.writeChunk({ role: 'assistant', content: '' });
                        roleSent = true;
                    }

                    // Send content chunk
                    if (parsedChunk.content && parsedChunk.content.trim()) {
                        const filteredContent = this.filterContent(parsedChunk.content);
                        if (filteredContent) {
                            this.logger.debug('Sending content chunk:', { filteredContent });
                            stream.writeChunk({ content: filteredContent });
                            assistantContent += filteredContent;
                            contentSent = true;
                            
                            // Call content callback if provided
                            if (contentCallback) {
                                contentCallback(filteredContent);
                            }
                        }
                    }
                } else if (parsedChunk.type === 'tool_calls') {
                    // Handle tool calls from Claude
                    this.logger.debug('Received tool calls chunk:', parsedChunk);
                    
                    // Send role chunk if not sent yet
                    if (!roleSent) {
                        stream.writeChunk({ role: 'assistant', content: '' });
                        roleSent = true;
                    }
                    
                    // Send tool calls in OpenAI format
                    if (parsedChunk.tool_calls) {
                        stream.writeChunk({ tool_calls: parsedChunk.tool_calls });
                        contentSent = true;
                    }
                } else if (parsedChunk.type === 'error') {
                    this.logger.error('Claude stream error chunk:', parsedChunk);
                    throw new Error(parsedChunk.error || 'Claude stream error');
                }
            }

            this.logger.debug(`Claude stream completed. Chunks processed: ${chunkCount}, roleSent: ${roleSent}, contentSent: ${contentSent}`);

            // Handle case where no content was sent
            if (chunkCount === 0) {
                this.logger.error('No chunks received from Claude CLI');
                throw new Error('No response from Claude CLI - check configuration and authentication');
            }
            
            if (roleSent && !contentSent) {
                const fallbackMessage = "I'm unable to provide a response at the moment.";
                this.logger.warn('No content sent, using fallback message');
                stream.writeChunk({ content: fallbackMessage });
                assistantContent = fallbackMessage;
                if (contentCallback) {
                    contentCallback(fallbackMessage);
                }
            } else if (!roleSent) {
                // Send at least the role
                this.logger.debug('Sending initial role chunk');
                stream.writeChunk({ role: 'assistant', content: '' });
                roleSent = true;
            }

            // Send final chunk
            if (roleSent) {
                this.logger.debug('Sending final chunk');
                stream.writeChunk({}, 'stop');
            }

            return assistantContent;

        } catch (error) {
            this.logger.error('Error processing Claude stream:', error);
            
            if (!stream.isClosed()) {
                stream.writeError(error);
            }
            
            throw error;
        }
    }

    parseClaudeChunk(chunk) {
        try {
            // If chunk is already an object (from Claude CLI parsing)
            if (typeof chunk === 'object') {
                return this.normalizeClaudeChunk(chunk);
            }

            // If chunk is a string, try to parse as JSON
            if (typeof chunk === 'string') {
                if (chunk.trim() === '') {
                    return { type: 'empty' };
                }

                try {
                    const parsed = JSON.parse(chunk);
                    this.logger.debug('Parsed JSON chunk:', { type: parsed.type, subtype: parsed.subtype });
                    return this.normalizeClaudeChunk(parsed);
                } catch (parseError) {
                    // Treat as raw text
                    return {
                        type: 'assistant_message',
                        content: chunk
                    };
                }
            }

            return { type: 'unknown', data: chunk };
        } catch (error) {
            this.logger.debug('Error parsing Claude chunk:', error);
            return { type: 'error', error: error.message };
        }
    }

    normalizeClaudeChunk(chunk) {
        // Handle different Claude CLI output formats
        
        // Skip system/init messages 
        if (chunk.type === 'system' || chunk.type === 'result' || chunk.type === 'user') {
            return { type: 'system', data: chunk };
        }
        
        // Handle Claude CLI assistant messages
        if (chunk.type === 'assistant' && chunk.message) {
            const message = chunk.message;
            
            // Check for tool calls in message content
            if (message.content && Array.isArray(message.content)) {
                const toolUseBlocks = message.content.filter(block => block.type === 'tool_use');
                if (toolUseBlocks.length > 0) {
                    return this.parseToolCalls({ content: message.content });
                }
                
                // Extract text content
                const textContent = this.extractContent(message.content);
                if (textContent) {
                    return {
                        type: 'assistant_message',
                        content: textContent
                    };
                }
            }
        }
        
        // Check for tool calls first
        if (chunk.tool_calls || (chunk.content && Array.isArray(chunk.content) && 
            chunk.content.some(block => block.type === 'tool_use'))) {
            return this.parseToolCalls(chunk);
        }

        if (chunk.content && Array.isArray(chunk.content)) {
            // New format: { content: [TextBlock, ...] }
            return {
                type: 'assistant_message',
                content: this.extractContent(chunk.content)
            };
        }

        if (chunk.type === 'text' && chunk.content) {
            // Direct text chunk
            return {
                type: 'assistant_message',
                content: chunk.content
            };
        }

        if (typeof chunk === 'string') {
            // Raw text
            return {
                type: 'assistant_message',
                content: chunk
            };
        }

        // Unknown format
        return {
            type: 'unknown',
            data: chunk
        };
    }

    parseToolCalls(chunk) {
        // Convert Claude tool calls to OpenAI format
        let toolCalls = [];
        
        if (chunk.tool_calls) {
            // Direct tool_calls array
            toolCalls = chunk.tool_calls;
        } else if (chunk.content && Array.isArray(chunk.content)) {
            // Extract tool_use blocks from content
            const toolUseBlocks = chunk.content.filter(block => block.type === 'tool_use');
            toolCalls = toolUseBlocks.map(block => ({
                id: block.id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            }));
        }
        
        if (toolCalls.length > 0) {
            return {
                type: 'tool_calls',
                tool_calls: toolCalls
            };
        }
        
        // No tool calls found, treat as regular content
        return {
            type: 'assistant_message',
            content: this.extractContent(chunk.content || chunk)
        };
    }

    extractContent(content) {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            let extractedText = '';
            
            for (const block of content) {
                if (typeof block === 'string') {
                    extractedText += block;
                } else if (block && typeof block === 'object') {
                    // Handle TextBlock objects
                    if (block.text) {
                        extractedText += block.text;
                    } else if (block.type === 'text' && block.text) {
                        extractedText += block.text;
                    } else if (block.content) {
                        extractedText += block.content;
                    }
                }
            }
            
            return extractedText;
        }

        return '';
    }

    filterContent(content) {
        if (!content || typeof content !== 'string') {
            return content;
        }

        // Remove tool usage blocks
        let filtered = content.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '');
        
        // Remove thinking blocks
        filtered = filtered.replace(/<thinking>[\s\S]*?<\/antml:thinking>/g, '');
        
        // Remove Claude Code specific markers
        filtered = filtered.replace(/\[Tool Use:.*?\]/g, '');
        filtered = filtered.replace(/\[File: .*?\]/g, '');
        
        // Clean up extra whitespace but preserve intentional formatting
        filtered = filtered.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
        
        return filtered;
    }

    // Helper method to create a basic SSE keepalive
    sendKeepAlive(stream) {
        if (!stream.isClosed()) {
            try {
                stream.res.write(': keepalive\n\n');
                return true;
            } catch (error) {
                this.logger.debug('Failed to send keepalive:', error);
                return false;
            }
        }
        return false;
    }

}

module.exports = { StreamingManager, StreamingResponse };