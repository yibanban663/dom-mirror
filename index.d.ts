import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { LaunchOptions } from 'puppeteer';

export interface TransferOptions {
  /** Hard per-file cap in bytes. Upload default 8 MiB, download default 32 MiB. */
  maxBytes?: number;
  /** Upload only: lowercase extensions accepted for mirrored uploads (default: text/image/office/zip). */
  extensions?: string[];
}

export interface UploadOptions extends TransferOptions {
  /** Session lifetime budget, including completed files; default twice maxBytes. */
  maxTotalBytes?: number;
  /** Pending transfers per session; default 2. */
  maxConcurrent?: number;
  /** Abandon idle partial transfers after this interval; default 30000 ms. */
  idleTimeoutMs?: number;
}

export interface MirrorOptions {
  /** Required; one fixed HTTP(S) source per instance. */
  originUrl: string;
  width?: number;
  height?: number;
  maxSessions?: number;
  sessionGraceMs?: number;
  allowedOrigins?: string[];
  /** Explicit origins eligible for Node-side cross-origin iframe fetching; default none. Hosts must also isolate outbound network access. */
  crossOriginFrameOrigins?: string[];
  defaultMode?: 'dom' | 'frame';
  /** Defaults to embedded; demo keeps the mode controls and statistics. */
  presentation?: 'embedded' | 'demo';
  obfuscate?: boolean;
  /** Mirror canvases with 2D contexts created after injection as draw-command streams (default true); others fall back to bitmap capture. */
  canvasStream?: boolean;
  /** Keep Chromium's sandbox (default true). Disable only where user namespaces are unavailable; a compromised renderer then runs with the host's privileges. */
  chromiumSandbox?: boolean;
  /** Input types whose mirrored values are replaced with up to 32 asterisks in snapshots/patches (default off). Interactivity is unaffected. */
  maskInputTypes?: string[];
  /** Remove these named attributes from mirrored elements, including html/body metadata. */
  redactAttributes?: string[];
  /** Synchronous, trusted host identity. Empty/null/undefined or errors reject the WS upgrade. */
  getSessionIdentity?: (req: IncomingMessage) => string | null | undefined;
  /** Overrides the built-in Puppeteer launch options, including args. */
  launchOptions?: LaunchOptions;
  /** Mirrored file uploads: size cap plus extension allowlist; temp files live for the session only. */
  upload?: UploadOptions;
  /** Mirrored downloads: size cap; files are streamed to the visitor and removed server-side after delivery. */
  download?: TransferOptions;
  logger?: Pick<Console, 'log'>;
}

export interface Mirror {
  handleRequest(req: IncomingMessage, res: ServerResponse): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Revoke one active or retained session by its sensitive resume token; await resource cleanup. */
  revokeSession(token: string): Promise<boolean>;
  /** Revoke all current sessions and pending WS handshakes for this exact host identity. Returns session count. */
  revokeIdentity(identity: string): Promise<number>;
  /** Idempotent; closes package resources, never the host HTTP server. */
  close(): Promise<void>;
}

export function createMirror(options: MirrorOptions): Mirror;
