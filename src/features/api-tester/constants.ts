// ============================================================
// API Tester — Shared Constants & Presets
// ============================================================

import type { HttpMethod, BodyType } from "@/stores/api-tester.store";

// ── Built-in Presets ─────────────────────────────────────────
export interface ApiPreset {
  name: string;
  method: HttpMethod;
  url: string;
  params: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  bodyType: BodyType;
  bodyValue?: string;
  description: string;
}

export const PRESETS: ApiPreset[] = [
  {
    name: "GitHub API - Get User",
    method: "GET",
    url: "https://api.github.com/users/octocat",
    params: [],
    headers: [
      { key: "Accept", value: "application/vnd.github.v3+json" },
      { key: "User-Agent", value: "DevUtils-API-Tester" },
    ],
    bodyType: "none",
    description: "Fetch public profile details for a GitHub user.",
  },
  {
    name: "ReqRes - Mock Authentication",
    method: "POST",
    url: "https://reqres.in/api/login",
    params: [],
    headers: [{ key: "Content-Type", value: "application/json" }],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        email: "eve.holt@reqres.in",
        password: "cityslicka",
      },
      null,
      2
    ),
    description: "Simulate a user login flow using ReqRes mock API.",
  },
  {
    name: "Postman Echo - Test Payload",
    method: "POST",
    url: "https://postman-echo.com/post",
    params: [{ key: "environment", value: "production" }],
    headers: [
      { key: "Content-Type", value: "application/json" },
      { key: "Authorization", value: "Bearer mock_token_123" },
    ],
    bodyType: "json",
    bodyValue: JSON.stringify(
      {
        event: "user_signup",
        properties: {
          plan: "pro",
          source: "api_tester",
        },
      },
      null,
      2
    ),
    description: "Echo service to test request headers, params, and body.",
  },
  {
    name: "JSONPlaceholder - Filter Data",
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/posts",
    params: [{ key: "userId", value: "1" }],
    headers: [{ key: "Accept", value: "application/json" }],
    bodyType: "none",
    description: "Fetch and filter mock blog posts using query parameters.",
  },
  {
    name: "CoinGecko - Crypto Prices",
    method: "GET",
    url: "https://api.coingecko.com/api/v3/simple/price",
    params: [
      { key: "ids", value: "bitcoin,ethereum" },
      { key: "vs_currencies", value: "usd" },
    ],
    headers: [{ key: "Accept", value: "application/json" }],
    bodyType: "none",
    description: "Fetch real-time cryptocurrency prices from CoinGecko.",
  },
];

// ── HTTP Methods ─────────────────────────────────────────────
export const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

// ── Protocol Options ─────────────────────────────────────────
import { Globe, Activity, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ApiProtocol = "rest" | "graphql" | "websocket";

export interface ProtocolOption {
  id: ApiProtocol;
  label: string;
  icon: LucideIcon;
}

export const PROTOCOLS: readonly ProtocolOption[] = [
  { id: "rest", label: "HTTP", icon: Globe },
  { id: "graphql", label: "GraphQL", icon: Activity },
  { id: "websocket", label: "WebSocket", icon: Wifi },
] as const;

// ── Raw Body Types ───────────────────────────────────────────
export const RAW_TYPES = [
  { value: "text/plain", label: "Text" },
  { value: "application/json", label: "JSON" },
  { value: "application/xml", label: "XML" },
  { value: "text/html", label: "HTML" },
  { value: "text/javascript", label: "JavaScript" },
];

// ── Header Autocomplete Data ─────────────────────────────────
export const HEADER_KEYS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Content-Type",
  "User-Agent",
  "X-API-Key",
];

export const COMMON_MIME_TYPES = [
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
  "text/plain",
  "text/html",
  "multipart/form-data",
];

export const HEADER_VALUES_MAP: Record<string, string[]> = {
  accept: COMMON_MIME_TYPES,
  "content-type": COMMON_MIME_TYPES,
  authorization: ["Bearer ", "Basic ", "Digest ", "OAuth "],
  "cache-control": [
    "no-cache",
    "no-store",
    "no-cache, no-store, must-revalidate",
    "max-age=3600",
    "public",
    "private",
  ],
  "accept-encoding": ["gzip", "deflate", "br", "gzip, deflate, br"],
  "accept-language": [
    "en-US,en;q=0.9",
    "en-GB,en;q=0.8",
    "fr-FR,fr;q=0.9",
    "es-ES,es;q=0.9",
  ],
};

// ── Utility Functions ────────────────────────────────────────
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1
  );
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function getTimeClass(ms: number): string {
  if (ms < 200) return "meta-time-fast";
  if (ms < 1000) return "meta-time-medium";
  return "meta-time-slow";
}

export function getLanguageFromContentType(contentType?: string): string {
  if (!contentType) return "text";
  const type = contentType.toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.includes("css")) return "css";
  if (type.includes("javascript")) return "javascript";
  return "text";
}
