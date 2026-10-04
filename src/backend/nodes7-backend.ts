import { IS7Backend } from './s7-backend.interface';
import { S7ConnectionConfig } from '../types/s7-connection';
import { S7ReadItem, S7ReadResult, S7WriteItem } from '../types/s7-address';
import { S7BlockInfo, S7BlockList, S7BlockType } from '../types/s7-browse';
import { toNodes7Address } from '../core/address-parser';
import { S7Error, S7ErrorCode, describeError, describeRawRequest } from '../utils/error-codes';

const BAD_QUALITY_HINT = ' (check that the address exists and is within the area or DB size)';

/**
 * Describes a failed nodes7 read/write. nodes7 passes `true` rather than an Error, and its
 * per-item quality doesn't say why (a missing DB and an out-of-range address both read
 * "BAD 255"), so name the addresses it marked bad, or all of them when there are no values.
 */
function failureDetail(err: unknown, addrs: string[], values?: Record<string, unknown>): string {
  if (err instanceof Error) return err.message;
  const isBad = (v: unknown): boolean =>
    (Array.isArray(v) ? v : [v]).some((q) => typeof q === 'string' && /^BAD \d+$/.test(q));
  const bad = values ? addrs.filter((a) => isBad(values[a])) : [];
  return `bad quality for ${(bad.length > 0 ? bad : addrs).join(', ')}${BAD_QUALITY_HINT}`;
}

const causeOf = (err: unknown): Error | undefined => (err instanceof Error ? err : undefined);

/**
 * nodes7's isoConnectionState when the link is up. It drops to 0 as soon as the socket closes
 * (PLC restart, cable reset by peer), with no request needed, and stays below 4 while nodes7
 * retries on its own.
 */
const ISO_CONNECTED = 4;

export class NodeS7Backend implements IS7Backend {
  private conn: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  private connected = false;

  async connect(config: S7ConnectionConfig): Promise<void> {
    // A reconnect must not leave the previous nodes7 instance (and its retry timers) running
    await this.disconnect();

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
      this.conn.initiateConnection(connParams, (err: unknown) => {
        if (err) {
          reject(new S7Error(S7ErrorCode.CONNECTION_FAILED, `nodes7 connection failed: ${describeError(err)}`, causeOf(err)));
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
    return this.connected && this.conn !== null && this.conn.isoConnectionState === ISO_CONNECTED;
  }

  /** True when we hold a connection but nodes7 reports the link as down. */
  private linkLost(): boolean {
    return this.conn !== null && this.conn.isoConnectionState !== ISO_CONNECTED;
  }

  private lostError(op: string): S7Error {
    return new S7Error(S7ErrorCode.DISCONNECTED, `nodes7 ${op} failed: connection to the PLC was lost`);
  }

  private assertConnected(op: string): void {
    if (!this.conn || !this.connected) {
      throw new S7Error(S7ErrorCode.DISCONNECTED, 'Not connected');
    }
    if (this.linkLost()) {
      throw this.lostError(op);
    }
  }

  async read(items: S7ReadItem[]): Promise<S7ReadResult[]> {
    this.assertConnected('read');

    const addrList = items.map((i) => i.nodes7Address ?? toNodes7Address(i.address));
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
        this.conn.readAllItems((err: unknown, values: Record<string, unknown>) => {
          removeAll();

          if (err && this.linkLost()) {
            reject(this.lostError('read'));
            return;
          }
          if (err) {
            reject(new S7Error(
              S7ErrorCode.READ_FAILED,
              `nodes7 read failed: ${failureDetail(err, addrList, values)}`,
              causeOf(err),
            ));
            return;
          }

          const results: S7ReadResult[] = items.map((item) => {
            const addr = item.nodes7Address ?? toNodes7Address(item.address);
            const value = values[addr];
            const isBad = value === undefined || value === null;
            return {
              name: item.name,
              address: item.address,
              value: isBad ? null : value,
              quality: isBad ? 'bad' : 'good',
              timestamp: Date.now(),
              error: isBad ? 'No value returned' : undefined,
            };
          });

          resolve(results);
        });
      } catch (e) {
        removeAll();
        throw e;
      }
    });
  }

  async write(items: S7WriteItem[]): Promise<void> {
    this.assertConnected('write');

    const names: string[] = [];
    const values: unknown[] = [];

    for (const item of items) {
      const addr = item.nodes7Address ?? toNodes7Address(item.address);
      this.conn.addItems(addr);
      names.push(addr);
      values.push(item.value);
    }

    const removeAll = (): void => {
      for (const name of names) {
        this.conn.removeItems(name);
      }
    };

    return new Promise<void>((resolve, reject) => {
      try {
        this.conn.writeItems(names, values, (err: unknown) => {
          removeAll();
          if (err && this.linkLost()) {
            reject(this.lostError('write'));
          } else if (err) {
            reject(new S7Error(S7ErrorCode.WRITE_FAILED, `nodes7 write failed: ${failureDetail(err, names)}`, causeOf(err)));
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
    this.assertConnected('read');

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
      this.conn.readAllItems((err: unknown, values: Record<string, unknown>) => {
        this.conn.removeItems(addr);
        if (err && this.linkLost()) {
          reject(this.lostError('read'));
          return;
        }
        if (err) {
          // Describe the request rather than the internal nodes7 address (DB1,BYTE200.8), which
          // the user never typed: struct, buffer and bits modes all read through here.
          const detail = err instanceof Error
            ? err.message
            : `bad quality reading ${describeRawRequest(area, dbNumber, start, length)}${BAD_QUALITY_HINT}`;
          reject(new S7Error(S7ErrorCode.READ_FAILED, `Raw read failed: ${detail}`, causeOf(err)));
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
