# Code Examples

## Basic Usage

Here's how to create a server:

```ts
import { Hono } from 'hono'
const app = new Hono()

app.get('/', (c) => c.text('Hello!'))

export default app
```

## Middleware

Apply middleware globally or per-route:

```ts
import { cors } from 'hono/cors'
app.use(
  '*',
  cors({
    origin: 'https://example.com',
    allowMethods: ['GET', 'POST']
  })
)
```

## Database Setup

```ts
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'

const sqlite = new Database('app.db')
const db = drizzle(sqlite)
```

## JSON Config

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "dependencies": {
    "hono": "^4.0.0"
  }
}
```
