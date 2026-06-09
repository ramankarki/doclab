import { createHash } from "node:crypto";
import type { SourceMeta, SourceKind } from "../types";

export interface FetchResult {
  content: string;
  contentType: string;
  isMarkdown: boolean;
  isHtml: boolean;
  hash: string;
  meta: Partial<SourceMeta>;
}

const JINA_BASE = "https://r.jina.ai/";

// Status codes that trigger Jina AI fallback
const FALLBACK_STATUSES = new Set([403, 429, 502, 503]);

// Patterns suggesting bot-detection pages (only checked on HTML responses)
const BOT_DETECTION_PATTERNS = [
  /<(?:title|h1)[^>]*>\s*(?:Just a moment|Attention Required|Access Denied|security check|verifying)/i,
  /Cloudflare Ray ID:/i,
  /id="challenge-error-text"/i,
  /g-recaptcha-response/i,
  /turnstile/i,
];

export async function fetchUrl(
  url: string,
  jinaApiKey?: string
): Promise<FetchResult> {
  // Try direct fetch first
  try {
    const result = await directFetch(url);
    return result;
  } catch (e: any) {
    if (e instanceof FetchError && e.status === 404) {
      throw e; // 404 is permanent — don't fallback
    }
    if (e instanceof FetchError && FALLBACK_STATUSES.has(e.status)) {
      return await jinaFetch(url, jinaApiKey);
    }
    // Connection errors also trigger fallback
    if (e.name === "FetchError" || e.cause?.code === "ECONNREFUSED") {
      return await jinaFetch(url, jinaApiKey);
    }
    throw e;
  }
}

async function directFetch(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "doclab/0.1 (local knowledge server)",
      Accept: "text/markdown, text/html, text/plain, */*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      throw new FetchError(
        `URL returned ${response.status}`,
        "NOT_FOUND",
        response.status
      );
    }
    throw new FetchError(
      `HTTP ${response.status}: ${response.statusText}`,
      "HTTP_ERROR",
      response.status
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  // Only check for bot-detection on HTML pages
  const isHtmlResponse = contentType.includes("text/html");
  if (isHtmlResponse && isBotDetectionPage(raw)) {
    throw new FetchError(
      "Bot detection page detected",
      "BOT_DETECTED",
      403
    );
  }

  const hash = createHash("sha256").update(raw).digest("hex");

  const isMarkdown =
    contentType.includes("text/markdown") ||
    contentType.includes("text/plain") ||
    url.endsWith(".md") ||
    url.endsWith(".txt") ||
    url.includes("llms-full.txt") ||
    url.includes("llms.txt");

  const isHtml = contentType.includes("text/html") || !isMarkdown;

  const meta = extractMeta(raw, isHtml, url);

  return {
    content: raw,
    contentType,
    isMarkdown,
    isHtml,
    hash,
    meta,
  };
}

async function jinaFetch(
  url: string,
  apiKey?: string
): Promise<FetchResult> {
  const jinaUrl = `${JINA_BASE}${url}`;
  const headers: Record<string, string> = {
    Accept: "text/markdown",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(jinaUrl, { headers });

  if (!response.ok) {
    throw new FetchError(
      `Jina AI fallback failed: HTTP ${response.status}`,
      "JINA_FAILED",
      response.status
    );
  }

  const raw = await response.text();
  const hash = createHash("sha256").update(raw).digest("hex");

  // Jina AI returns clean markdown
  const meta = extractMeta(raw, false, url);

  return {
    content: raw,
    contentType: "text/markdown",
    isMarkdown: true,
    isHtml: false,
    hash,
    meta,
  };
}

function isBotDetectionPage(html: string): boolean {
  // Only run on HTML content (caller ensures this)
  return BOT_DETECTION_PATTERNS.some((p) => p.test(html));
}

function extractMeta(
  raw: string,
  isHtml: boolean,
  url: string
): Partial<SourceMeta> {
  const meta: Partial<SourceMeta> = {};
  const u = new URL(url);
  meta.domain = u.hostname;
  meta.url = url;

  if (isHtml) {
    // Extract title
    const titleMatch = raw.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) {
      meta.title = titleMatch[1].trim();
    }

    // Extract author
    const authorMatch = raw.match(
      /<meta[^>]+name=["']author["'][^>]+content=["']([^"']*)["']/i
    );
    if (authorMatch) {
      meta.author = authorMatch[1];
    }

    // Extract published date
    const dateMatch = raw.match(
      /<meta[^>]+(?:property=["']article:published_time["']|name=["']date["'])[^>]+content=["']([^"']*)["']/i
    );
    if (dateMatch) {
      meta.publishedAt = dateMatch[1];
    }
  } else {
    // Markdown — try first h1 as title
    const h1Match = raw.match(/^#\s+(.+)$/m);
    if (h1Match) {
      meta.title = h1Match[1].trim();
    }
  }

  // Detect version
  const versionMatch = raw
    .slice(0, 5000)
    .match(
      /(?:v(?:ersion[:\s]*)?)(\d+\.\d+\.\d+)|(?:###\s+v?(\d+\.\d+\.\d+))/i
    );
  if (versionMatch) {
    meta.version = versionMatch[1] || versionMatch[2];
  }

  // Detect kind
  meta.kind = detectKind(url, raw, isHtml);

  return meta;
}

function detectKind(url: string, _raw: string, _isHtml: boolean): SourceKind {
  const path = new URL(url).pathname.toLowerCase();

  if (url.includes("llms-full.txt") || url.includes("llms.txt")) {
    return "docs";
  }
  if (path.includes("/docs/") || path.includes("/reference/")) {
    return "docs";
  }
  if (path.includes("/api/")) {
    return "reference";
  }

  const domain = new URL(url).hostname;
  if (
    domain.includes("dev.to") ||
    domain.includes("medium.com") ||
    domain.includes("freecodecamp.org") ||
    domain.includes("blog.")
  ) {
    return "article";
  }

  if (
    path.includes("/tutorial") ||
    path.includes("/guide") ||
    path.includes("/learn")
  ) {
    return "tutorial";
  }

  return "unknown";
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function chunkHash(source: string, sectionPath: string): string {
  return createHash("sha256")
    .update(`${source}:${sectionPath}`)
    .digest("hex")
    .slice(0, 16);
}

export class FetchError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "FetchError";
  }
}
