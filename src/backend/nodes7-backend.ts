import { IS7Backend } from './s7-backend.interface';
import { S7ConnectionConfig } from '../types/s7-connection';
import { S7ReadItem, S7ReadResult, S7WriteItem } from '../types/s7-address';
import { S7BlockInfo, S7BlockList, S7BlockType } from '../types/s7-browse';
import { toNodes7Address } from '../core/address-parser';
import { S7Error, S7ErrorCode } from '../utils/error-codes';

// The address types nodes7 0.3.18 understands (stringToS7Addr in nodeS7.js). It silently drops
// any other item, so a write never calls back on a fresh connection, and on a connection that
// has written before it sends the previous write again and reports success. Check first.
// LINT is left out too: nodes7 parses it, but its LINT read and write are commented out, so a read
// returns nothing and a write sends eight zero bytes.
const NODES7_DB_TYPES = new Set([
  'X', 'B', 'C', 'BYTE', 'CHAR', 'W', 'WORD', 'I', 'INT', 'DW', 'DWT', 'DWORD', 'DI', 'DINT',
  'R', 'REAL', 'LR', 'LREAL', 'WDT', 'DT', 'DTZ', 'DTL', 'DTLZ', 'S', 'STRING',
]);
const NODES7_UNFINISHED_TYPES = new Set(['LI', 'LINT']);
const AREA_SUFFIXES = ['', 'B', 'C', 'W', 'I', 'D', 'DI', 'R', 'LR'];
const NODES7_AREA_TYPES = new Set([
  ...['I', 'E', 'Q', 'A', 'M'].flatMap((area) => AREA_SUFFIXES.map((s) => area + s)),
  ...['PI', 'PE', 'PQ', 'PA'].flatMap((area) => ['B', 'C', 'W', 'I', 'D', 'DI', 'R'].map((s) => area + s)),
  'T', 'C',
]);

/** Returns why nodes7 can't handle this address, or undefined if it can. */
export function nodes7Unsupported(addr: string): string | undefined {
  const [db, rest] = addr.split(',');
  if (rest !== undefined) {
    const parts = rest.split('.');
    const type = parts[0].replace(/[0-9]/g, '').toUpperCase(); // as nodes7 reads it, so S5TIME is "STIME"
    if (NODES7_UNFINISHED_TYPES.has(type)) {
      return `"${addr}" isn't supported by the nodes7 backend (nodes7 can't read or write LINT); use the snap7 backend for it`;
    }
    if (!NODES7_DB_TYPES.has(type)) {
      const name = parts[0].replace(/\d+$/, '').toUpperCase();
      return `"${addr}" isn't supported by the nodes7 backend (nodes7 has no ${name} type); use the snap7 backend for it`;
    }
    if ((type === 'STRING' || type === 'S') && parts.length < 2) {
      return `"${addr}" needs the string's max length for the nodes7 backend, e.g. "${db},${rest}.20" for a STRING[20]`;
    }
    return undefined;
  }
  const type = addr.split('.')[0].replace(/[0-9]/g, '');
  if (!NODES7_AREA_TYPES.has(type)) {
    return `"${addr}" isn't supported by the nodes7 backend; use the snap7 backend for it`;
  }
  return undefined;
}

export class NodeS7Backend implements IS7Backend {
  private conn: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  private connected = false;

  async connect(config: S7ConnectionConfig): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodes7 = require('nodes7');
    // nodeS7 defaults silentMode to false, which logs every read/poll cycle
    // (raw protocol trace) to stdout and can grow container logs to GBs.
    // Keep it silent unless the user explicitly enables debug logging.
    this.conn = new nodes7({ silent: config.debug !== true });

    const connParams: Record<string, unknown> = {
      host: config.host,
      port: config.port,
      rack: config.rack,
      slot: config.slot,
    };

    if (config.localTSAP !== undefined) {
      connParams.localTSAP = config.localTSAP;
    }
    if (config.remoteTSAP !== undefined) {
      connParams.remoteTSAP = config.remoteTSAP;
    }
    if (config.connectionTimeout !== undefined) {
      connParams.timeout = config.connectionTimeout;
    }

    return new Promise<void>((resolve, reject) => {
      this.conn.initiateConnection(connParams, (err: Error | undefined) => {
        if (err) {
          reject(new S7Error(S7ErrorCode.CONNECTION_FAILED, `nodes7 connection failed: ${err.message}`, err));
        } else {
          this.connected = true;
          resolve();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      try {
        this.conn.dropConnection();
      } catch {
        // ignore disconnect errors
      } finally {
        this.connected = false;
        this.conn = null;
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async read(items: S7ReadItem[]): Promise<S7ReadResult[]> {
    if (!this.conn || !this.connected) {
      throw new S7Error(S7ErrorCode.DISCONNECTED, 'Not connected');
    }

    const prepared = items.map((item) => {
      const addr = item.nodes7Address ?? toNodes7Address(item.address);
      return { item, addr, unsupported: nodes7Unsupported(addr) };
    });
    // Addresses nodes7 can't handle are reported bad without being sent to it
    const addrList = prepared.filter((p) => !p.unsupported).map((p) => p.addr);

    const toResults = (values: Record<string, unknown>): S7ReadResult[] =>
      prepared.map(({ item, addr, unsupported }) => {
        const value = unsupported ? undefined : values[addr];
        const isBad = value === undefined || value === null;
        return {
          name: item.name,
          address: item.address,
          value: isBad ? null : value,
          quality: isBad ? 'bad' : 'good',
          timestamp: Date.now(),
          error: unsupported ?? (isBad ? 'No value returned' : undefined),
        };
      });

    if (addrList.length === 0) {
      return toResults({});
    }

    for (const addr of addrList) {
      this.conn.addItems(addr);
    }

    const removeAll = (): void => {
      for (const addr of addrList) {
        this.conn.removeItems(addr);
      }
    };

    return new Promise<S7ReadResult[]>((resolve, reject) => {
      try {
        this.conn.readAllItems((err: Error | undefined, values: Record<string, unknown>) => {
          removeAll();

          if (err) {
            reject(new S7Error(S7ErrorCode.READ_FAILED, `nodes7 read failed: ${err.message}`, err));
            return;
          }

          resolve(toResults(values));
        });
      } catch (e) {
        removeAll();
        throw e;
      }
    });
  }

  async write(items: S7WriteItem[]): Promise<void> {
    if (!this.conn || !this.connected) {
      throw new S7Error(S7ErrorCode.DISCONNECTED, 'Not connected');
    }

    const names = items.map((item) => item.nodes7Address ?? toNodes7Address(item.address));
    const values = items.map((item) => item.value);

    // Refuse the whole write rather than let nodes7 drop part of it (see NODES7_DB_TYPES)
    for (const addr of names) {
      const unsupported = nodes7Unsupported(addr);
      if (unsupported) {
        throw new S7Error(S7ErrorCode.WRITE_FAILED, unsupported);
      }
    }

    for (const addr of names) {
      this.conn.addItems(addr);
    }

    const removeAll = (): void => {
      for (const name of names) {
        this.conn.removeItems(name);
      }
    };

    return new Promise<void>((resolve, reject) => {
      try {
        this.conn.writeItems(names, values, (err: Error | undefined) => {
          removeAll();
          if (err) {
            reject(new S7Error(S7ErrorCode.WRITE_FAILED, `nodes7 write failed: ${err.message}`, err));
          } else {
            resolve();
          }
        });
      } catch (e) {
        removeAll();
        throw e;
      }
    });
  }

  async readRawArea(area: number, dbNumber: number, start: number, length: number): Promise<Buffer> {
    // nodes7 doesn't have a direct raw area read, so we construct a BYTE read
    if (!this.conn || !this.connected) {
      throw new S7Error(S7ErrorCode.DISCONNECTED, 'Not connected');
    }

    const areaMap: Record<number, string> = {
      0x81: 'I',
      0x82: 'Q',
      0x83: 'M',
      0x84: 'DB',
    };

    const areaPrefix = areaMap[area];
    if (!areaPrefix) {
      throw new S7Error(S7ErrorCode.READ_FAILED, `Unsupported area code: ${area}`);
    }

    let addr: string;
    if (areaPrefix === 'DB') {
      addr = `DB${dbNumber},BYTE${start}.${length}`;
    } else {
      addr = `${areaPrefix}B${start}.${length}`;
    }

    this.conn.addItems(addr);

    return new Promise<Buffer>((resolve, reject) => {
      this.conn.readAllItems((err: Error | undefined, values: Record<string, unknown>) => {
        this.conn.removeItems(addr);
        if (err) {
          reject(new S7Error(S7ErrorCode.READ_FAILED, `Raw read failed: ${err.message}`, err));
          return;
        }
        const val = values[addr];
        if (Buffer.isBuffer(val)) {
          resolve(val);
        } else if (Array.isArray(val)) {
          resolve(Buffer.from(val as number[]));
        } else if (typeof val === 'number') {
          const buf = Buffer.alloc(1);
          buf.writeUInt8(val);
          resolve(buf);
        } else {
          reject(new S7Error(S7ErrorCode.READ_FAILED, 'Unexpected value type from raw read'));
        }
      });
    });
  }

  // Probe-based browse for nodes7 (no native block listing)
  async listBlocks(): Promise<S7BlockList> {
    throw new S7Error(
      S7ErrorCode.BROWSE_FAILED,
      'nodes7 does not support native block listing. Use probe-based browsing.',
    );
  }

  async listBlocksOfType(_blockType: S7BlockType): Promise<number[]> {
    throw new S7Error(
      S7ErrorCode.BROWSE_FAILED,
      'nodes7 does not support native block type listing.',
    );
  }

  async getBlockInfo(_blockType: S7BlockType, _blockNumber: number): Promise<S7BlockInfo> {
    throw new S7Error(
      S7ErrorCode.BROWSE_FAILED,
      'nodes7 does not support native block info.',
    );
  }

  async readSZL(_id: number, _index: number): Promise<Buffer> {
    throw new S7Error(S7ErrorCode.BROWSE_FAILED, 'nodes7 does not support SZL reads.');
  }
}
