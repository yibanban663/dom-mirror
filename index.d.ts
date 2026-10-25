import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { LaunchOptions } from 'puppeteer';

export interface MirrorOptions {
  /** Required; one fixed HTTP(S) source per instance. */
  originUrl: string;
  width?: number;
  height?: number;
  maxSessions?: number;
  sessionGraceMs?: number;
  allowedOrigins?: string[];
  defaultMode?: 'dom' | 'frame';
  /** Defaults to embedded; demo keeps the mode controls and statistics. */
  presentation?: 'embedded' | 'demo';
  obfuscate?: boolean;
  /** Remove these named attributes from mirrored elements, including html/body metadata. */
  redactAttributes?: string[];
  /** Synchronous, trusted host identity. Empty/null/undefined or errors reject the WS upgrade. */
  getSessionIdentity?: (req: IncomingMessage) => string | null | undefined;
  /** Overrides the built-in Puppeteer launch options, including args. */
  launchOptions?: LaunchOptions;
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
