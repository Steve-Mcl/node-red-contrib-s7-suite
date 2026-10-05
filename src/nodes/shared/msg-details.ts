import { S7ConfigNode } from '../s7-config/s7-config-types';

/** What an S7 node did, sent as msg.s7 with its output. The same shape on every node. */
export interface S7MsgDetails {
  /** read, write or trigger, or the msg.action that ran: connect, disconnect, reconnect, status */
  op: string;
  /** The s7-config's name, or host:port when it has none */
  server: string;
  /** Where the address came from: "config" (set in the node) or the property, e.g. "flow.plc.address" */
  source?: string;
  /** The address, when one address was read or written */
  address?: string;
  /** Output key to address, when msg.payload is keyed by address or label */
  addresses?: Record<string, string>;
  /** When the message was sent, in ms since 1970 */
  timestamp: number;
  /** ms from the message arriving (s7-trigger: the poll starting) to it being sent */
  durationMs: number;
}

export interface S7MsgDetailsExtra {
  source?: string;
  address?: string;
  addresses?: Record<string, string>;
}

/** The s7-config's name, or host:port, as the editor labels it. */
export function serverLabel(serverNode: S7ConfigNode): string {
  if (serverNode.name) return serverNode.name;
  const cfg = serverNode.s7Config;
  return cfg ? `${cfg.host}:${cfg.port}` : '';
}

/** Builds msg.s7 for an operation that started at `started` (Date.now()) and is sending now. */
export function s7Details(
  serverNode: S7ConfigNode, op: string, started: number, extra: S7MsgDetailsExtra = {},
): S7MsgDetails {
  const timestamp = Date.now();
  // Only the fields that apply, in a fixed order so the debug sidebar reads the same every time
  return {
    op,
    server: serverLabel(serverNode),
    ...(extra.source !== undefined && { source: extra.source }),
    ...(extra.address !== undefined && { address: extra.address }),
    ...(extra.addresses !== undefined && { addresses: extra.addresses }),
    timestamp,
    durationMs: timestamp - started,
  };
}
