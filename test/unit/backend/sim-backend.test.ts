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

  it('writes and reads back a DTLZ as a Date', async () => {
    const address = { area: 'DB' as const, dbNumber: 1, dataType: 'DTLZ' as const, offset: 40, bitOffset: 0 };
    const when = new Date('2024-03-17T10:30:45.123Z');
    await backend.write([{ name: 'd', address, value: when }]);
    const results = await backend.read([{ name: 'd', address }]);
    expect(results[0].value).toEqual(when);
  });

  it('returns LINT as the config asks', async () => {
    const big = new SimBackend();
    await big.connect({ ...config, int64As: 'bigint' });
    const address = { area: 'DB' as const, dbNumber: 1, dataType: 'LINT' as const, offset: 56, bitOffset: 0 };
    await big.write([{ name: 'l', address, value: '9007199254740993' }]);
    expect((await big.read([{ name: 'l', address }]))[0].value).toBe(9007199254740993n);
    expect((await backend.read([{ name: 'l', address }]))[0].value).toBe(0); // separate sim, default 'number'
    await big.disconnect();
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

  it('writes a STRING without touching anything after it', async () => {
    const str = { area: 'DB' as const, dbNumber: 1, dataType: 'STRING' as const, offset: 50, bitOffset: 0, stringLength: 20 };
    const after = { area: 'DB' as const, dbNumber: 1, dataType: 'DWORD' as const, offset: 72, bitOffset: 0 };
    await backend.write([{ name: 'after', address: after, value: 0xAABBCCDD }]);

    // First write declares the STRING[20] in the empty header, the second keeps it
    await backend.write([{ name: 's', address: str, value: 'hello world' }]);
    await backend.write([{ name: 's', address: { ...str, stringLength: undefined }, value: 'hi' }]);

    const raw = await backend.readRawArea(0x84, 1, 50, 2);
    expect([...raw]).toEqual([20, 2]);
    const results = await backend.read([{ name: 's', address: str }, { name: 'after', address: after }]);
    expect(results[0].value).toBe('hi');
    expect(results[1].value).toBe(0xAABBCCDD);
  });

  it('rejects a STRING write with no known length', async () => {
    await expect(backend.write([{
      name: 's',
      address: { area: 'DB', dbNumber: 1, dataType: 'STRING', offset: 60, bitOffset: 0 },
      value: 'x',
    }])).rejects.toThrow('has an empty header');
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
