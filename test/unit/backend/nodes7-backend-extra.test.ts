import { NodeS7Backend, nodes7Unsupported } from '../../../src/backend/nodes7-backend';
import { parseAddress, toNodes7Address } from '../../../src/core/address-parser';

const mockInitiateConnection = jest.fn();
const mockDropConnection = jest.fn();
const mockAddItems = jest.fn();
const mockRemoveItems = jest.fn();
const mockReadAllItems = jest.fn();
const mockWriteItems = jest.fn();

jest.mock('nodes7', () => {
  return jest.fn().mockImplementation(() => ({
    initiateConnection: mockInitiateConnection,
    dropConnection: mockDropConnection,
    addItems: mockAddItems,
    removeItems: mockRemoveItems,
    readAllItems: mockReadAllItems,
    writeItems: mockWriteItems,
  }));
});

describe('NodeS7Backend - rawArea and edge cases', () => {
  let backend: NodeS7Backend;

  beforeEach(async () => {
    backend = new NodeS7Backend();
    jest.clearAllMocks();
    mockInitiateConnection.mockImplementation((_p: unknown, cb: Function) => cb());
    await backend.connect({
      host: '192.168.1.100', port: 102, rack: 0, slot: 1,
      plcType: 'S7-1200', backend: 'nodes7',
    });
  });

  it('readRawArea with DB area returns buffer', async () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'DB1,BYTE0.3': buf });
    });

    const result = await backend.readRawArea(0x84, 1, 0, 3);
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('readRawArea with M area', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'MB0.1': 42 });
    });

    const result = await backend.readRawArea(0x83, 0, 0, 1);
    expect(result.readUInt8(0)).toBe(42);
  });

  it('readRawArea with I area', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'IB0.1': 5 });
    });

    const result = await backend.readRawArea(0x81, 0, 0, 1);
    expect(result.readUInt8(0)).toBe(5);
  });

  it('readRawArea with Q area', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'QB0.1': 7 });
    });

    const result = await backend.readRawArea(0x82, 0, 0, 1);
    expect(result.readUInt8(0)).toBe(7);
  });

  it('readRawArea throws for unsupported area', async () => {
    await expect(backend.readRawArea(0x99, 0, 0, 1)).rejects.toThrow('Unsupported area code');
  });

  it('readRawArea handles array result', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'DB1,BYTE0.3': [1, 2, 3] });
    });

    const result = await backend.readRawArea(0x84, 1, 0, 3);
    expect(result).toEqual(Buffer.from([1, 2, 3]));
  });

  it('readRawArea handles unexpected value type', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'DB1,BYTE0.3': 'unexpected' });
    });

    await expect(backend.readRawArea(0x84, 1, 0, 3)).rejects.toThrow('Unexpected value type');
  });

  it('readRawArea handles read error', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(new Error('Read timeout'));
    });

    await expect(backend.readRawArea(0x84, 1, 0, 1)).rejects.toThrow('Raw read failed');
  });

  it('readRawArea throws when not connected', async () => {
    await backend.disconnect();
    await expect(backend.readRawArea(0x84, 1, 0, 1)).rejects.toThrow('Not connected');
  });

  it('read marks null values as bad quality', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'DB1,REAL0': null });
    });

    const results = await backend.read([{
      name: 'test',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
      nodes7Address: 'DB1,REAL0',
    }]);

    expect(results[0].quality).toBe('bad');
    expect(results[0].value).toBeNull();
  });

  it('read generates nodes7Address from address when not provided', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => {
      cb(undefined, { 'DB1,REAL0': 42.0 });
    });

    const results = await backend.read([{
      name: 'test',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
      // no nodes7Address
    }]);

    expect(results[0].value).toBe(42.0);
  });

  it('write generates nodes7Address from address when not provided', async () => {
    mockWriteItems.mockImplementation((_n: unknown, _v: unknown, cb: Function) => cb());

    await backend.write([{
      name: 'test',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
      value: 1.0,
    }]);

    expect(mockAddItems).toHaveBeenCalledWith('DB1,REAL0');
  });

  it('write throws when not connected', async () => {
    await backend.disconnect();
    await expect(backend.write([{
      name: 'test',
      address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
      value: 1.0,
    }])).rejects.toThrow('Not connected');
  });

  it('refuses a write nodes7 would drop, without sending anything', async () => {
    await expect(backend.write([
      { name: 'ok', address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 0, bitOffset: 0 }, value: 1 },
      { name: 'u', address: { area: 'DB', dbNumber: 1, dataType: 'UINT', offset: 10, bitOffset: 0 }, value: 5 },
    ])).rejects.toThrow('"DB1,UINT10" isn\'t supported by the nodes7 backend (nodes7 has no UINT type)');

    expect(mockAddItems).not.toHaveBeenCalled();
    expect(mockWriteItems).not.toHaveBeenCalled();
  });

  it('reports an address nodes7 would drop as bad, and still reads the rest', async () => {
    mockReadAllItems.mockImplementation((cb: Function) => cb(undefined, { 'DB1,INT0': 7 }));

    const results = await backend.read([
      { name: 'ok', address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 0, bitOffset: 0 } },
      { name: 'u', address: { area: 'DB', dbNumber: 1, dataType: 'UINT', offset: 2, bitOffset: 0 } },
    ]);

    expect(mockAddItems).toHaveBeenCalledTimes(1);
    expect(mockAddItems).toHaveBeenCalledWith('DB1,INT0');
    expect(results[0]).toMatchObject({ value: 7, quality: 'good' });
    expect(results[1]).toMatchObject({ value: null, quality: 'bad' });
    expect(results[1].error).toContain('nodes7 has no UINT type');
  });

  it('does not call nodes7 when no address in a read is supported', async () => {
    const results = await backend.read([
      { name: 'u', address: { area: 'DB', dbNumber: 1, dataType: 'USINT', offset: 2, bitOffset: 0 } },
    ]);

    expect(mockReadAllItems).not.toHaveBeenCalled();
    expect(results[0].quality).toBe('bad');
  });

  it('connect passes timeout when configured', async () => {
    const backend2 = new NodeS7Backend();
    mockInitiateConnection.mockImplementation((params: Record<string, unknown>, cb: Function) => {
      expect(params.timeout).toBe(3000);
      cb();
    });

    await backend2.connect({
      host: '192.168.1.100', port: 102, rack: 0, slot: 1,
      plcType: 'S7-1200', backend: 'nodes7',
      connectionTimeout: 3000,
    });
  });
});

describe('nodes7Unsupported', () => {
  const via = (address: string): string | undefined => nodes7Unsupported(toNodes7Address(parseAddress(address)));

  it.each([
    'DB1,INT0', 'DB1,DINT4', 'DB1,WORD0', 'DB1,DWORD0', 'DB1,BYTE0', 'DB1,CHAR0', 'DB1,REAL0', 'DB1,LREAL0',
    'DB1,STRING0.20', 'DB1.DBW0', 'DB1.DBD0', 'DB1.DBB0',
    'MB0', 'MW0', 'MD0', 'M0.1', 'IB0', 'I0.0', 'QW2', 'Q0.0',
  ])('accepts %s', (address) => {
    expect(via(address)).toBeUndefined();
  });

  it.each([
    ['DB1,WSTRING0', 'WSTRING'], ['DB1,USINT0', 'USINT'], ['DB1,UINT0', 'UINT'], ['DB1,UDINT0', 'UDINT'],
    ['DB1,ULINT0', 'ULINT'], ['DB1,DATE0', 'DATE'], ['DB1,TIME0', 'TIME'], ['DB1,TIME_OF_DAY0', 'TIME_OF_DAY'],
    ['DB1,DATE_AND_TIME0', 'DATE_AND_TIME'], ['DB1,S5TIME0', 'S5TIME'],
  ])('rejects %s', (address, type) => {
    expect(via(address)).toContain(`nodes7 has no ${type} type`);
  });

  it('rejects LINT, which nodes7 parses but never reads or writes', () => {
    expect(via('DB1,LINT0')).toBe(
      '"DB1,LINT0" isn\'t supported by the nodes7 backend (nodes7 can\'t read or write LINT); use the snap7 backend for it',
    );
    for (const addr of ['DB1,LI0', 'MLI0', 'ILI0', 'QLI0', 'ELI0', 'ALI0']) {
      expect(nodes7Unsupported(addr)).toBeDefined();
    }
  });

  it('rejects a STRING with no length', () => {
    expect(via('DB1,STRING10')).toBe(
      '"DB1,STRING10" needs the string\'s max length for the nodes7 backend, e.g. "DB1,STRING10.20" for a STRING[20]',
    );
  });

  it('rejects counters and timers, which become CW/TW', () => {
    expect(via('C0')).toContain('"CW0" isn\'t supported by the nodes7 backend');
    expect(via('T0')).toContain('"TW0" isn\'t supported by the nodes7 backend');
  });

  it('accepts the nodes7 forms s7-suite does not generate itself', () => {
    for (const addr of ['DB1,X0.0', 'DB1,S0.20', 'DB1,DTL0', 'MR0', 'EB0', 'AW0', 'PIW256', 'T0', 'C0']) {
      expect(nodes7Unsupported(addr)).toBeUndefined();
    }
  });
});
