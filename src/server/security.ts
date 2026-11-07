/**
 * The local server's guards (docs/ARCHITECTURE.md「守り」).
 *
 * The server rewrites configuration files, and the threat is any web page the
 * owner happens to have open: it can `fetch("http://127.0.0.1:47821/…")`, or
 * point a DNS name it controls at 127.0.0.1 (rebinding). Every request is
 * therefore checked in this order:
 *
 *  1. `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>` — a rebound
 *     name fails here even though the TCP connection reached us.
 *  2. `Origin`, when present, is this server's own origin; and `Sec-Fetch-Site`,
 *     when present, is `same-origin` (or `none` for a top-level navigation).
 *  3. The per-start token, in **both** the HttpOnly SameSite=Strict cookie and
 *     the `X-Console-Token` header. A cross-site page can make the browser send
 *     neither: the cookie is Strict and the header cannot be read or forged
 *     without the token.
 *
 * The cookie and the header carry **different** secrets. Cookies are not
 * port-scoped, so any other service the browser visits on 127.0.0.1 receives
 * the cookie; if the header token could be fetched with the cookie alone, that
 * service would hold both. The header token is
 * therefore handed out once, on the one-time launch page, and kept by the tab
 * in `sessionStorage` — which *is* scoped to the origin, port included.
 *
 * No CORS header is ever sent, so even a response that slipped past cannot be
 * read by another origin.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * The cookie name carries the port. Cookies are not port-scoped, so every
 * service on 127.0.0.1 receives this cookie; the name at least keeps two
 * agent-console servers on different ports from overwriting each other's.
 * (What a foreign port does with the cookie is answered by the header token
 * being a different secret — see app.ts.)
 */
export function cookieName(port: number): string {
  return `ac_token_${port}`;
}
export const TOKEN_HEADER = "x-console-token";

/** A fresh 32-byte token, hex-encoded. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** What the lock file records instead of the token itself. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string equality (for tokens). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** The Host values this server answers to. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return allowedHosts(port).includes(host.toLowerCase());
}

/** The origins this server considers itself. */
export function selfOrigins(port: number): string[] {
  return allowedHosts(port).map((h) => `http://${h}`);
}

/**
 * Cross-origin signals on a request. `Origin` absent is allowed (a non-browser
 * client, or a same-origin GET that some browsers send without it); present and
 * foreign is not. `Sec-Fetch-Site` is the browser's own verdict and is honoured
 * when sent.
 */
export function crossOriginReason(req: IncomingMessage, port: number): string | null {
  const origin = header(req, "origin");
  if (origin !== undefined && !selfOrigins(port).includes(origin.toLowerCase())) {
    return `foreign Origin: ${origin}`;
  }
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return `Sec-Fetch-Site: ${site}`;
  }
  return null;
}

/** Is this request one a browser made (rather than a local CLI client)? */
export function looksLikeBrowser(req: IncomingMessage): boolean {
  return (
    header(req, "origin") !== undefined ||
    header(req, "sec-fetch-site") !== undefined ||
    header(req, "sec-fetch-mode") !== undefined
  );
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Every value sent under one cookie name, in the order the browser sent them.
 *
 * A browser sends several same-named cookies when they differ in Path, longest
 * path first — and any service on another 127.0.0.1 port can set one with
 * `Path=/api`. Reading only the first would let that planted cookie shadow the
 * real one and lock the console out until the browser is restarted.
 */
export function readCookies(req: IncomingMessage, name: string): string[] {
  const raw = req.headers["cookie"];
  const lines = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const values: string[] = [];
  for (const line of lines) {
    for (const part of line.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
    }
  }
  return values;
}

/** Read the first cookie of a name. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  return readCookies(req, name)[0];
}

export function hasCookieToken(req: IncomingMessage, port: number, token: string): boolean {
  return readCookies(req, cookieName(port)).some((value) => safeEqual(value, token));
}

export function hasHeaderToken(req: IncomingMessage, token: string): boolean {
  const value = header(req, TOKEN_HEADER);
  return value !== undefined && safeEqual(value, token);
}

export function tokenCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * One-time launch codes. The URL the launcher opens carries one of these rather
 * than the token, so the token never lands in the browser's history: the code
 * is exchanged once for the cookie and is dead afterwards.
 */
export class LaunchCodes {
  private readonly codes = new Map<string, number>();

  /** At most this many unredeemed codes are kept; issuing past it drops the oldest. */
  static readonly MAX_OUTSTANDING = 16;

  constructor(private readonly ttlMs = 120_000) {}

  issue(now = Date.now()): string {
    this.prune(now);
    while (this.codes.size >= LaunchCodes.MAX_OUTSTANDING) {
      const oldest = this.codes.keys().next().value as string;
      this.codes.delete(oldest);
    }
    const code = randomBytes(32).toString("hex");
    this.codes.set(code, now + this.ttlMs);
    return code;
  }

  /** How many codes are still redeemable (for tests). */
  outstanding(now = Date.now()): number {
    this.prune(now);
    return this.codes.size;
  }

  private prune(now: number): void {
    for (const [known, expiry] of this.codes) {
      if (expiry < now) this.codes.delete(known);
    }
  }

  /** Consume a code. True only once, and only before it expires. */
  redeem(code: string, now = Date.now()): boolean {
    this.prune(now);
    for (const known of this.codes.keys()) {
      if (safeEqual(known, code)) {
        this.codes.delete(known);
        return true;
      }
    }
    return false;
  }
}

/**
 * The control secret's proof of identity for `/control/ping`.
 *
 * The control secret is written only to the lock file, which sits in the
 * owner's profile. A process that grabbed the port after a crash can answer a
 * ping with the right PID — it cannot answer with HMAC(secret, nonce).
 */
export function controlProof(controlKey: string, nonce: string): string {
  return createHmac("sha256", controlKey).update(nonce).digest("hex");
}

/** A minimum interval between events (`/control/open` may not open tabs in a loop). */
export class RateLimit {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs: number) {}

  allow(now = Date.now()): boolean {
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }
}

/** Response headers every answer carries. */
export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
