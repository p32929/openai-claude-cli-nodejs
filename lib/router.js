const url = require('url');

class HTTPError extends Error {
    constructor(statusCode, message, type = 'api_error') {
        super(message);
        this.statusCode = statusCode;
        this.type = type;
    }
}

class Router {
    constructor() {
        this.routes = {
            GET: new Map(),
            POST: new Map(),
            PUT: new Map(),
            DELETE: new Map(),
            PATCH: new Map()
        };
    }

    get(path, handler) {
        this.addRoute('GET', path, handler);
    }

    post(path, handler) {
        this.addRoute('POST', path, handler);
    }

    put(path, handler) {
        this.addRoute('PUT', path, handler);
    }

    delete(path, handler) {
        this.addRoute('DELETE', path, handler);
    }

    patch(path, handler) {
        this.addRoute('PATCH', path, handler);
    }

    addRoute(method, path, handler) {
        if (!this.routes[method]) {
            this.routes[method] = new Map();
        }
        
        // Convert path patterns like :id to regex
        const pattern = this.pathToPattern(path);
        this.routes[method].set(pattern, {
            originalPath: path,
            handler
        });
    }

    pathToPattern(path) {
        // Convert path patterns like '/users/:id' to regex patterns
        const regexPath = path
            .replace(/\//g, '\\/')
            .replace(/:([^\/]+)/g, '(?<$1>[^\/]+)');
        
        return new RegExp(`^${regexPath}$`);
    }

    async route(req, res) {
        const method = req.method;
        const pathname = req.pathname;
        
        if (!this.routes[method]) {
            return { handled: false };
        }

        // Try to match routes
        for (const [pattern, route] of this.routes[method]) {
            const match = pathname.match(pattern);
            
            if (match) {
                // Extract path parameters
                req.params = match.groups || {};
                
                try {
                    await route.handler(req, res);
                    return { handled: true };
                } catch (error) {
                    // Re-throw to be handled by the main error handler
                    throw error;
                }
            }
        }

        return { handled: false };
    }
}

module.exports = Router;