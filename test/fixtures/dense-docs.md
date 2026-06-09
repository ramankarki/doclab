# Framework Documentation

## Middleware

Hono provides built-in middleware for common tasks including CORS, rate limiting,
logging, compression, authentication, caching, and more. Each middleware is imported
from its own submodule and applied globally or per-route. This section provides a
comprehensive overview of all available middleware and how to use them effectively
in your Hono applications. Middleware can be chained together to create complex
request processing pipelines with minimal overhead and maximum flexibility.

### CORS

Cross-Origin Resource Sharing middleware for Hono applications. This middleware
allows you to configure which origins, methods, and headers are permitted for
cross-origin requests to your API endpoints.

```ts
import { cors } from 'hono/cors'
const app = new Hono()
app.use('*', cors({
  origin: 'https://example.com',
  allowMethods: ['GET', 'POST'],
}))
```

### Rate Limiting

Protect your API from abuse with rate limiting middleware that controls how
many requests a client can make within a specified time window. This is essential
for preventing denial of service attacks and ensuring fair resource usage.

```ts
import { rateLimiter } from 'hono/rate-limiter'
app.use('*', rateLimiter({
  windowMs: 60000,
  max: 100,
}))
```

### Logging

Request logging middleware for debugging and monitoring your application.
It logs incoming requests, response times, and status codes to help you
understand traffic patterns and identify performance bottlenecks.

```ts
import { logger } from 'hono/logger'
app.use('*', logger())
```

### Compression

Compress responses to reduce bandwidth usage and improve page load times.
This middleware automatically compresses response bodies using gzip or deflate
based on the client's Accept-Encoding header. Compression significantly reduces
the amount of data transferred over the network for text-based content.

```ts
import { compress } from 'hono/compress'
app.use('*', compress())
```

### Authentication

Built-in authentication helpers for common auth patterns including basic
authentication, bearer tokens, and JWT verification. These middleware
components integrate seamlessly with Hono's context API and can be
combined with custom authorization logic for fine-grained access control.

```ts
import { basicAuth } from 'hono/basic-auth'
app.use('/admin/*', basicAuth({
  username: 'admin',
  password: 'secret',
}))
```

### Caching

Cache responses to improve performance and reduce server load. The caching
middleware supports in-memory caching with configurable TTL values and
automatic cache invalidation based on request parameters or headers.

```ts
import { cache } from 'hono/cache'
app.get('/api/data', cache({ expires: 3600 }), (c) => {
  return c.json({ data: 'cached' })
})
```

### Error Handling

Global error handler for consistent error responses across your application.
This middleware catches unhandled errors and transforms them into structured
JSON responses with appropriate HTTP status codes and error messages.

```ts
import { HTTPException } from 'hono/http-exception'
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  return c.json({ error: 'Internal Server Error' }, 500)
})
```
