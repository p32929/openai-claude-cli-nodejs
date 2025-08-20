const { spawn } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

class ClaudeProcess extends EventEmitter {
    constructor(config, logger) {
        super();
        this.config = config;
        this.logger = logger;
        this.process = null;
        this.buffer = '';
        this.isRunning = false;
        this.startTime = null;
    }

    async execute(prompt, options = {}) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            this.startTime = startTime;
            
            // Build Claude CLI command
            const args = this.buildClaudeArgs(prompt, options);
            
            this.logger.debug(`Executing Claude CLI: ${this.config.claudeCliPath} ${args.join(' ')}`);
            
            // Spawn Claude process
            const spawnOptions = {
                cwd: options.cwd || this.config.claudeCwd,
                env: { 
                    ...process.env, 
                    ...this.config.getClaudeEnvVars(),
                    ...options.env 
                },
                stdio: ['pipe', 'pipe', 'pipe']
            };

            // On Windows, use shell: true for .cmd files
            if (process.platform === 'win32') {
                spawnOptions.shell = true;
            }

            this.process = spawn(this.config.claudeCliPath, args, spawnOptions);

            this.isRunning = true;
            this.buffer = '';

            // Send prompt via stdin
            if (prompt) {
                this.process.stdin.write(prompt);
                this.process.stdin.end();
            }

            // Handle stdout data
            this.process.stdout.on('data', (data) => {
                const chunk = data.toString();
                this.buffer += chunk;
                this.emit('data', chunk);
            });

            // Handle stderr
            this.process.stderr.on('data', (data) => {
                const errorOutput = data.toString();
                this.logger.debug('Claude CLI stderr:', errorOutput);
                this.emit('error_data', errorOutput);
            });

            // Handle process completion
            this.process.on('close', (code) => {
                this.isRunning = false;
                const duration = Date.now() - startTime;
                
                // Cleanup system prompt file if it was created
                if (options.systemPromptFile) {
                    this.cleanupSystemPromptFile(options.systemPromptFile);
                }
                
                this.logger.logClaudeInteraction(
                    this.config.claudeCliPath,
                    args,
                    duration,
                    code === 0
                );

                if (code === 0) {
                    resolve({
                        output: this.buffer,
                        exitCode: code,
                        duration
                    });
                } else {
                    reject(new Error(`Claude CLI exited with code ${code}. Output: ${this.buffer}`));
                }
            });

            // Handle process errors
            this.process.on('error', (error) => {
                this.isRunning = false;
                const duration = Date.now() - startTime;
                
                // Cleanup system prompt file if it was created
                if (options.systemPromptFile) {
                    this.cleanupSystemPromptFile(options.systemPromptFile);
                }
                
                this.logger.logClaudeInteraction(
                    this.config.claudeCliPath,
                    args,
                    duration,
                    false
                );
                
                reject(new Error(`Failed to start Claude CLI: ${error.message}`));
            });

        });
    }

    async *executeStreaming(prompt, options = {}) {
        const startTime = Date.now();
        this.startTime = startTime;
        
        // Build Claude CLI command
        const args = this.buildClaudeArgs(prompt, options);
        
        this.logger.info(`Executing Claude CLI (streaming): ${this.config.claudeCliPath} ${args.join(' ')}`);
        this.logger.debug(`Prompt length: ${prompt ? prompt.length : 0} characters`);
        
        // Spawn Claude process
        const spawnOptions = {
            cwd: options.cwd || this.config.claudeCwd,
            env: { 
                ...process.env, 
                ...this.config.getClaudeEnvVars(),
                ...options.env 
            },
            stdio: ['pipe', 'pipe', 'pipe']
        };

        // On Windows, use shell: true for .cmd files
        if (process.platform === 'win32') {
            spawnOptions.shell = true;
        }

        this.process = spawn(this.config.claudeCliPath, args, spawnOptions);

        this.isRunning = true;
        let buffer = '';
        let errorBuffer = '';
        let chunkCount = 0;

        // Send prompt via stdin
        if (prompt) {
            this.process.stdin.write(prompt);
            this.process.stdin.end();
        }


        try {
            // Create async iterator for stdout chunks
            const stdout = this.process.stdout;
            const stderr = this.process.stderr;

            // Handle stderr separately
            stderr.on('data', (data) => {
                const errorText = data.toString();
                errorBuffer += errorText;
                this.logger.error('Claude CLI stderr:', errorText);
            });

            // Handle process errors
            this.process.on('error', (error) => {
                this.logger.error('Claude CLI process error:', error);
                throw new Error(`Failed to start Claude CLI: ${error.message}`);
            });

            // Process stdout chunks
            for await (const chunk of this.streamToAsyncIterator(stdout)) {
                chunkCount++;
                buffer += chunk;
                this.logger.debug(`Received chunk ${chunkCount}, size: ${chunk.length}`);
                
                // Try to parse as JSON lines or structured output
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const parsed = this.parseClaudeOutput(line.trim());
                            this.logger.debug('Parsed Claude output:', parsed);
                            yield parsed;
                        } catch (parseError) {
                            this.logger.warn('Failed to parse Claude output line:', { line: line.trim(), error: parseError.message });
                            // Yield as raw text
                            yield {
                                type: 'text',
                                content: line.trim()
                            };
                        }
                    }
                }
            }

            // Wait for process to complete
            const exitCode = await this.waitForExit();
            
            const duration = Date.now() - startTime;
            this.logger.info(`Claude CLI completed in ${duration}ms with exit code ${exitCode}, processed ${chunkCount} chunks`);
            
            if (errorBuffer) {
                this.logger.warn('Claude CLI stderr output:', errorBuffer);
            }
            
            if (chunkCount === 0 && buffer.length === 0) {
                this.logger.error('No output received from Claude CLI');
                throw new Error('No output from Claude CLI - check model name and authentication');
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error(`Claude CLI streaming error after ${duration}ms:`, error.message);
            
            if (errorBuffer) {
                this.logger.error('Claude CLI stderr:', errorBuffer);
            }
            
            throw new Error(`Claude CLI streaming error: ${error.message}${errorBuffer ? '. Stderr: ' + errorBuffer : ''}`);
        } finally {
            this.isRunning = false;
            
            // Cleanup system prompt file if it was created
            if (options.systemPromptFile) {
                this.cleanupSystemPromptFile(options.systemPromptFile);
            }
        }
    }

    createSystemPromptFile(systemPrompt) {
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `claude-system-prompt-${Date.now()}-${Math.random().toString(36).substring(2, 11)}.txt`);
        
        try {
            fs.writeFileSync(tempFile, systemPrompt, 'utf8');
            return tempFile;
        } catch (error) {
            throw new Error(`Failed to create system prompt file: ${error.message}`);
        }
    }

    cleanupSystemPromptFile(filePath) {
        if (filePath && fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
            } catch (error) {
                // Log error but don't throw - cleanup failures shouldn't break the process
                console.warn(`Failed to cleanup system prompt file ${filePath}:`, error.message);
            }
        }
    }

    buildClaudeArgs(prompt, options = {}) {
        const args = [];

        // Add model if specified
        if (options.model) {
            args.push('--model', options.model);
        }

        // Add system prompt if specified using --system-prompt-file
        if (options.systemPrompt) {
            options.systemPromptFile = this.createSystemPromptFile(options.systemPrompt);
            args.push('--system-prompt-file', options.systemPromptFile);
        }

        // Add max turns
        if (options.maxTurns) {
            args.push('--max-turns', options.maxTurns.toString());
        }

        // Add print flag for non-interactive mode
        args.push('--print');

        // Add streaming output format if needed
        if (options.stream) {
            args.push('--output-format', 'stream-json');
            args.push('--verbose'); // Required for stream-json
        }

        // Tools are enabled via allowedTools/disallowedTools lists
        // No separate --tools flag needed

        // Add allowed tools
        if (options.allowedTools && options.allowedTools.length > 0) {
            args.push('--allowedTools', options.allowedTools.join(','));
        }

        // Add disallowed tools for security
        if (options.disallowedTools && options.disallowedTools.length > 0) {
            args.push('--disallowedTools', options.disallowedTools.join(','));
        }

        // Add permission mode
        if (options.permissionMode) {
            args.push('--permission-mode', options.permissionMode);
        }

        // Note: prompt is sent via stdin, not as argument when using --print
        return args;
    }

    parseClaudeOutput(line) {
        try {
            // Try to parse as JSON first (for structured output)
            const parsed = JSON.parse(line);
            return parsed;
        } catch (error) {
            // If not JSON, treat as raw text
            return {
                type: 'text',
                content: line
            };
        }
    }

    async *streamToAsyncIterator(stream) {
        let buffer = '';
        
        const iterator = {
            [Symbol.asyncIterator]() {
                return this;
            },
            
            async next() {
                return new Promise((resolve, reject) => {
                    const onData = (chunk) => {
                        cleanup();
                        resolve({ value: chunk.toString(), done: false });
                    };
                    
                    const onEnd = () => {
                        cleanup();
                        resolve({ done: true });
                    };
                    
                    const onError = (error) => {
                        cleanup();
                        reject(error);
                    };
                    
                    const cleanup = () => {
                        stream.removeListener('data', onData);
                        stream.removeListener('end', onEnd);
                        stream.removeListener('error', onError);
                    };
                    
                    stream.on('data', onData);
                    stream.on('end', onEnd);
                    stream.on('error', onError);
                });
            }
        };
        
        yield* iterator;
    }

    async waitForExit() {
        if (!this.process) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.process.on('close', (code) => {
                if (code === 0) {
                    resolve(code);
                } else {
                    reject(new Error(`Process exited with code ${code}`));
                }
            });

            this.process.on('error', reject);
        });
    }

    kill() {
        if (this.process && this.isRunning) {
            this.logger.debug('Killing Claude CLI process');
            this.process.kill('SIGTERM');
            this.isRunning = false;
        }
    }

    getDuration() {
        return this.startTime ? Date.now() - this.startTime : 0;
    }
}

class ClaudeCLI {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    async verify() {
        try {
            this.logger.info('Verifying Claude CLI...');
            
            const process = new ClaudeProcess(this.config, this.logger);
            const result = await process.execute('Hello', {});

            this.logger.info('✅ Claude CLI verification successful');
            return true;
        } catch (error) {
            this.logger.error('❌ Claude CLI verification failed:', error.message);
            return false;
        }
    }

    async completion(prompt, options = {}) {
        const process = new ClaudeProcess(this.config, this.logger);
        return await process.execute(prompt, options);
    }

    async *streamingCompletion(prompt, options = {}) {
        const process = new ClaudeProcess(this.config, this.logger);
        yield* process.executeStreaming(prompt, { ...options, stream: true });
    }

    // Helper method to convert messages to prompt format
    messagesToPrompt(messages) {
        let systemPrompt = '';
        let conversationPrompt = '';

        for (const message of messages) {
            if (message.role === 'system') {
                systemPrompt += message.content + '\n';
            } else if (message.role === 'user') {
                conversationPrompt += `Human: ${message.content}\n\n`;
            } else if (message.role === 'assistant') {
                conversationPrompt += `Assistant: ${message.content}\n\n`;
            }
        }

        // Add final Human prompt if the last message wasn't from user
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role !== 'user') {
            conversationPrompt += 'Human: Please continue.\n\n';
        }

        return {
            systemPrompt: systemPrompt.trim() || null,
            prompt: conversationPrompt.trim()
        };
    }

    // Helper method to parse Claude response
    parseResponse(output) {
        if (!output) {
            return '';
        }

        // Remove Claude CLI formatting if present
        let content = output.replace(/^Assistant: /, '').trim();
        
        // Filter out tool usage and thinking blocks
        content = content.replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '');
        content = content.replace(/<thinking>[\s\S]*?<\/antml:thinking>/g, '');
        
        // Clean up extra whitespace
        content = content.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
        
        return content;
    }
}

module.exports = ClaudeCLI;