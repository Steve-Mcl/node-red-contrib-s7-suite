import { NodeAPI, Node, NodeMessage } from 'node-red';
import { splitAddresses } from '../../core/address-parser';

/** Reads a typedInput value (msg, flow, global, env, ...) for this message. */
export function evaluateProperty(
  RED: NodeAPI, node: Node, msg: NodeMessage, type: string, value: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    RED.util.evaluateNodeProperty(value, type, node, msg, (err: Error | null, result: unknown) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export interface AddressEntry {
  address: string;
  label?: string;
}

/**
 * Turns an address taken from msg, flow, global or env into entries. It can be a string of
 * addresses (space- or semicolon-separated), an array of addresses, or `{ label: address }`.
 */
export function toAddressEntries(value: unknown, source: string): AddressEntry[] {
  if (value === undefined || value === null || value === '') {
    throw new Error(`No address in ${source}`);
  }
  if (typeof value === 'string') {
    return splitAddresses(value).map((address) => ({ address }));
  }
  if (Array.isArray(value) && value.every((a) => typeof a === 'string')) {
    return value.map((a: string) => a.trim()).filter(Boolean).map((address) => ({ address }));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.every(([, a]) => typeof a === 'string')) {
      return entries.map(([label, a]) => ({ address: (a as string).trim(), label }));
    }
  }
  throw new Error(
    `${source} must be an address string, an array of addresses or an object of { label: address }`
    + ` (got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value})`,
  );
}
