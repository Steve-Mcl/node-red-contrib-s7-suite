import { SimBackend } from '../../../src/backend/sim-backend';
import { S7ConnectionConfig } from '../../../src/types/s7-connection';

const config: S7ConnectionConfig = {
  host: '127.0.0.1', port: 102, rack: 0, slot: 1,
  plcType: 'S7-1200', backend: 'sim',
};

describe('SimBackend', () => {
  let backend: SimBackend;

  beforeEach(async () => {
    backend = new SimBackend();
    await backend.connect(config);
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  it('connects and disconnects', async () => {
    expect(backend.isConnected()).toBe(true);
    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);
  });

  it('reads initial REAL value from DB1', async () => {
    const results = await backend.read([{
      name: 'temp',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
    }]);
    expect(results[0].quality).toBe('good');
    expect(results[0].value).toBeCloseTo(23.5);
  });

  it('reads initial INT value from DB1', async () => {
    const results = await backend.read([{
      name: 'count',
      address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 4, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(42);
  });

  it('reads initial BOOL value from DB1', async () => {
    const results = await backend.read([{
      name: 'flag',
      address: { area: 'DB', dbNumber: 1, dataType: 'BOOL', offset: 6, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(true);
  });

  it('reads initial DINT value from DB1', async () => {
    const results = await backend.read([{
      name: 'bigint',
      address: { area: 'DB', dbNumber: 1, dataType: 'DINT', offset: 8, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(123456);
  });

  it('writes and reads back REAL', async () => {
    await backend.write([{
      name: 'temp',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
      value: 99.9,
    }]);

    const results = await backend.read([{
      name: 'temp',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
    }]);
    expect(results[0].value).toBeCloseTo(99.9, 1);
  });

  it('writes and reads back several values, from an array or a Buffer', async () => {
    const address = { area: 'DB' as const, dbNumber: 1, dataType: 'INT' as const, offset: 60, bitOffset: 0, arrayLength: 3 };
    await backend.write([{ name: 'a', address, value: [1, -2, 300] }]);
    expect((await backend.read([{ name: 'a', address }]))[0].value).toEqual([1, -2, 300]);

    const raw = Buffer.alloc(6);
    raw.writeInt16BE(7, 0); raw.writeInt16BE(8, 2); raw.writeInt16BE(9, 4);
    await backend.write([{ name: 'a', address, value: raw }]);
    expect((await backend.read([{ name: 'a', address }]))[0].value).toEqual([7, 8, 9]);
  });

  it('refuses several values of the wrong length', async () => {
    const address = { area: 'DB' as const, dbNumber: 1, dataType: 'BYTE' as const, offset: 60, bitOffset: 0, arrayLength: 4 };
    await expect(backend.write([{ name: 'a', address, value: [1, 2] }])).rejects.toThrow('takes 4 values; the array has 2');
  });

  it('writes and reads several bits as packed bits, keeping the bits around them', async () => {
    // Bits 3 to 10: byte 70 bits 3-7, byte 71 bits 0-2
    const bytes = { area: 'DB' as const, dbNumber: 1, dataType: 'BYTE' as const, offset: 70, bitOffset: 0, arrayLength: 2 };
    const bits = { area: 'DB' as const, dbNumber: 1, dataType: 'BOOL' as const, offset: 70, bitOffset: 3, arrayLength: 8 };
    await backend.write([{ name: 'b', address: bytes, value: [0x01, 0x80] }]);
    await backend.write([{ name: 'b', address: bits, value: Array(8).fill(true) }]);
    expect((await backend.read([{ name: 'b', address: bytes }]))[0].value).toEqual([0xf9, 0x87]);
    expect((await backend.read([{ name: 'b', address: bits }]))[0].value).toEqual(Array(8).fill(true));
  });

  it('writes and reads back INT', async () => {
    await backend.write([{
      name: 'count',
      address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 4, bitOffset: 0 },
      value: -500,
    }]);

    const results = await backend.read([{
      name: 'count',
      address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 4, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(-500);
  });

  it('writes and reads back BOOL', async () => {
    await backend.write([{
      name: 'flag',
      address: { area: 'DB', dbNumber: 1, dataType: 'BOOL', offset: 6, bitOffset: 0 },
      value: false,
    }]);

    const results = await backend.read([{
      name: 'flag',
      address: { area: 'DB', dbNumber: 1, dataType: 'BOOL', offset: 6, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(false);
  });

  it('returns bad quality for non-existent area', async () => {
    const results = await backend.read([{
      name: 'x',
      address: { area: 'DB', dbNumber: 999, dataType: 'REAL', offset: 0, bitOffset: 0 },
    }]);
    expect(results[0].quality).toBe('bad');
  });

  it('returns bad quality for out-of-range offset', async () => {
    const results = await backend.read([{
      name: 'x',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 200, bitOffset: 0 },
    }]);
    expect(results[0].quality).toBe('bad');
  });

  it('auto-creates area on write to non-existent DB', async () => {
    await backend.write([{
      name: 'x',
      address: { area: 'DB', dbNumber: 50, dataType: 'INT', offset: 0, bitOffset: 0 },
      value: 777,
    }]);

    const results = await backend.read([{
      name: 'x',
      address: { area: 'DB', dbNumber: 50, dataType: 'INT', offset: 0, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(777);
  });

  it('reads Merker area', async () => {
    await backend.write([{
      name: 'm',
      address: { area: 'M', dbNumber: 0, dataType: 'BYTE', offset: 0, bitOffset: 0 },
      value: 0xAB,
    }]);

    const results = await backend.read([{
      name: 'm',
      address: { area: 'M', dbNumber: 0, dataType: 'BYTE', offset: 0, bitOffset: 0 },
    }]);
    expect(results[0].value).toBe(0xAB);
  });

  it('readRawArea for DB', async () => {
    const buf = await backend.readRawArea(0x84, 1, 0, 4);
    expect(buf.length).toBe(4);
    expect(buf.readFloatBE(0)).toBeCloseTo(23.5);
  });

  it('readRawArea for M', async () => {
    const buf = await backend.readRawArea(0x83, 0, 0, 1);
    expect(buf.length).toBe(1);
  });

  it('readRawArea for I', async () => {
    const buf = await backend.readRawArea(0x81, 0, 0, 1);
    expect(buf.length).toBe(1);
  });

  it('readRawArea for Q', async () => {
    const buf = await backend.readRawArea(0x82, 0, 0, 1);
    expect(buf.length).toBe(1);
  });

  it('readRawArea throws for unknown area', async () => {
    await expect(backend.readRawArea(0x99, 0, 0, 1)).rejects.toThrow('Unknown area code');
  });

  it('readRawArea throws for non-existent area', async () => {
    await expect(backend.readRawArea(0x84, 999, 0, 1)).rejects.toThrow('not found');
  });

  it('readRawArea throws for out-of-range', async () => {
    await expect(backend.readRawArea(0x84, 1, 200, 10)).rejects.toThrow('Out of range');
  });

  it('listBlocks returns DB count', async () => {
    const list = await backend.listBlocks();
    expect(list.DBCount).toBeGreaterThanOrEqual(1);
  });

  it('listBlocksOfType returns DB numbers', async () => {
    const dbs = await backend.listBlocksOfType('DB');
    expect(dbs).toContain(1);
  });

  it('listBlocksOfType returns empty for non-DB', async () => {
    const obs = await backend.listBlocksOfType('OB');
    expect(obs).toEqual([]);
  });

  it('getBlockInfo returns block metadata', async () => {
    const info = await backend.getBlockInfo('DB', 1);
    expect(info.blockNumber).toBe(1);
    expect(info.sizeData).toBe(100);
    expect(info.author).toBe('SIM');
  });

  it('readSZL returns CPU info', async () => {
    const buf = await backend.readSZL(0x001c, 0);
    expect(buf.toString()).toContain('Simulator');
  });
});
