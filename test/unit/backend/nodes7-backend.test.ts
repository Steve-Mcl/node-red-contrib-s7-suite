import { NodeS7Backend } from '../../../src/backend/nodes7-backend';

// Mock nodes7 module
const mockInitiateConnection = jest.fn();
const mockDropConnection = jest.fn();
const mockAddItems = jest.fn();
const mockRemoveItems = jest.fn();
const mockReadAllItems = jest.fn();
const mockWriteItems = jest.fn();
// nodes7's isoConnectionState: 4 = link up, lower = down/reconnecting
const mockIso = { state: 4 };

jest.mock('nodes7', () => {
  return jest.fn().mockImplementation(() => ({
    get isoConnectionState() { return mockIso.state; },
    initiateConnection: mockInitiateConnection,
    dropConnection: mockDropConnection,
    addItems: mockAddItems,
    removeItems: mockRemoveItems,
    readAllItems: mockReadAllItems,
    writeItems: mockWriteItems,
  }));
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockNodes7 = require('nodes7') as jest.Mock;

describe('NodeS7Backend', () => {
  let backend: NodeS7Backend;

  beforeEach(() => {
    backend = new NodeS7Backend();
    jest.clearAllMocks();
    mockIso.state = 4;
  });

  describe('connect', () => {
    it('connects successfully', async () => {
      mockInitiateConnection.mockImplementation((_params: unknown, cb: Function) => cb());

      await backend.connect({
        host: '192.168.1.100',
        port: 102,
        rack: 0,
        slot: 1,
        plcType: 'S7-1200',
        backend: 'nodes7',
      });

      expect(backend.isConnected()).toBe(true);
      expect(mockInitiateConnection).toHaveBeenCalledTimes(1);
    });

    it('handles connection error', async () => {
      mockInitiateConnection.mockImplementation((_params: unknown, cb: Function) =>
        cb(new Error('Connection refused')),
      );

      await expect(
        backend.connect({
          host: '192.168.1.100',
          port: 102,
          rack: 0,
          slot: 1,
          plcType: 'S7-1200',
          backend: 'nodes7',
        }),
      ).rejects.toThrow('nodes7 connection failed');
    });

    it('includes a string connect error from nodes7 in the message', async () => {
      mockInitiateConnection.mockImplementation((_params: unknown, cb: Function) =>
        cb("Error - TCP connected, ISO didn't"),
      );

      await expect(
        backend.connect({
          host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
        }),
      ).rejects.toThrow("nodes7 connection failed: Error - TCP connected, ISO didn't");
    });

    it('constructs nodes7 in silent mode by default (no verbose protocol logging)', async () => {
      mockInitiateConnection.mockImplementation((_params: unknown, cb: Function) => cb());

      await backend.connect({
        host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
      });

      expect(mockNodes7).toHaveBeenCalledWith({ silent: true });
    });

    it('enables verbose logging when debug is true', async () => {
      mockInitiateConnection.mockImplementation((_params: unknown, cb: Function) => cb());

      await backend.connect({
        host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
        debug: true,
      });

      expect(mockNodes7).toHaveBeenCalledWith({ silent: false });
    });

    it('passes TSAP params', async () => {
      mockInitiateConnection.mockImplementation((params: Record<string, unknown>, cb: Function) => {
        expect(params.localTSAP).toBe(0x0100);
        expect(params.remoteTSAP).toBe(0x0200);
        cb();
      });

      await backend.connect({
        host: '192.168.1.100',
        port: 102,
        rack: 0,
        slot: 1,
        plcType: 'LOGO',
        backend: 'nodes7',
        localTSAP: 0x0100,
        remoteTSAP: 0x0200,
      });
    });
  });

  describe('connection loss', () => {
    const cfg = {
      host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200' as const, backend: 'nodes7' as const,
    };
    const item = {
      name: 'temp',
      address: { area: 'DB' as const, dbNumber: 1, dataType: 'REAL' as const, offset: 0, bitOffset: 0 },
      nodes7Address: 'DB1,REAL0',
    };

    beforeEach(async () => {
      mockInitiateConnection.mockImplementation((_p: unknown, cb: Function) => cb());
      await backend.connect(cfg);
    });

    it('reports not connected as soon as nodes7 drops isoConnectionState', () => {
      expect(backend.isConnected()).toBe(true);
      mockIso.state = 0; // socket closed by the PLC
      expect(backend.isConnected()).toBe(false);
    });

    it('rejects a read with DISCONNECTED when the link fails during the read', async () => {
      mockReadAllItems.mockImplementation((cb: Function) => {
        mockIso.state = 1; // nodes7 is retrying
        cb(true, { 'DB1,REAL0': 'BAD 255' });
      });

      await expect(backend.read([item])).rejects.toMatchObject({
        code: 'DISCONNECTED',
        message: 'nodes7 read failed: connection to the PLC was lost',
      });
    });

    it('still reports a bad address as READ_FAILED while the link is up', async () => {
      mockReadAllItems.mockImplementation((cb: Function) => cb(true, { 'DB1,REAL0': 'BAD 255' }));

      await expect(backend.read([item])).rejects.toMatchObject({ code: 'READ_FAILED' });
    });

    it('fails fast without asking nodes7 when the link is already down', async () => {
      mockIso.state = 0;

      await expect(backend.write([{ ...item, value: 1 }])).rejects.toMatchObject({ code: 'DISCONNECTED' });
      await expect(backend.readRawArea(0x84, 1, 0, 4)).rejects.toMatchObject({ code: 'DISCONNECTED' });
      expect(mockWriteItems).not.toHaveBeenCalled();
      expect(mockReadAllItems).not.toHaveBeenCalled();
    });

    it('drops the previous nodes7 connection when reconnecting', async () => {
      await backend.connect(cfg);

      expect(mockDropConnection).toHaveBeenCalledTimes(1);
      expect(mockNodes7).toHaveBeenCalledTimes(2);
    });
  });

  describe('disconnect', () => {
    it('disconnects cleanly', async () => {
      mockInitiateConnection.mockImplementation((_p: unknown, cb: Function) => cb());
      await backend.connect({
        host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
      });

      await backend.disconnect();
      expect(backend.isConnected()).toBe(false);
      expect(mockDropConnection).toHaveBeenCalled();
    });
  });

  describe('read', () => {
    beforeEach(async () => {
      mockInitiateConnection.mockImplementation((_p: unknown, cb: Function) => cb());
      await backend.connect({
        host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
      });
    });

    it('reads values successfully', async () => {
      mockReadAllItems.mockImplementation((cb: Function) => {
        cb(undefined, { 'DB1,REAL0': 3.14 });
      });

      const results = await backend.read([
        {
          name: 'temp',
          address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
          nodes7Address: 'DB1,REAL0',
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].value).toBe(3.14);
      expect(results[0].quality).toBe('good');
    });

    it('handles read error', async () => {
      mockReadAllItems.mockImplementation((cb: Function) => {
        cb(new Error('Read timeout'));
      });

      await expect(
        backend.read([
          {
            name: 'temp',
            address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
            nodes7Address: 'DB1,REAL0',
          },
        ]),
      ).rejects.toThrow('nodes7 read failed');
    });

    it('names the addresses nodes7 marked bad (it passes true, not an Error)', async () => {
      mockReadAllItems.mockImplementation((cb: Function) => {
        cb(true, { 'DB1,REAL0': 3.14, 'DB6,REAL0': 'BAD 255', 'DB1,BYTE0.4': ['BAD 255', 'BAD 255'] });
      });

      const read = backend.read(
        ['DB1,REAL0', 'DB6,REAL0', 'DB1,BYTE0.4'].map((a) => ({
          name: a,
          address: { area: 'DB' as const, dbNumber: 1, dataType: 'REAL' as const, offset: 0, bitOffset: 0 },
          nodes7Address: a,
        })),
      );

      await expect(read).rejects.toThrow(
        'nodes7 read failed: bad quality for DB6,REAL0, DB1,BYTE0.4 (check that the address exists',
      );
    });

    it('does not mistake a good string value for a bad quality', async () => {
      mockReadAllItems.mockImplementation((cb: Function) => {
        cb(true, { 'DB1,STRING0.10': 'BAD BATCH', 'DB6,REAL0': 'BAD 10' });
      });

      await expect(
        backend.read(['DB1,STRING0.10', 'DB6,REAL0'].map((a) => ({
          name: a,
          address: { area: 'DB' as const, dbNumber: 1, dataType: 'STRING' as const, offset: 0, bitOffset: 0 },
          nodes7Address: a,
        }))),
      ).rejects.toThrow(/bad quality for DB6,REAL0 \(/);
    });

    it('throws when not connected', async () => {
      await backend.disconnect();
      await expect(
        backend.read([
          {
            name: 'temp',
            address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
          },
        ]),
      ).rejects.toThrow('Not connected');
    });
  });

  describe('write', () => {
    beforeEach(async () => {
      mockInitiateConnection.mockImplementation((_p: unknown, cb: Function) => cb());
      await backend.connect({
        host: '192.168.1.100', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
      });
    });

    it('writes values successfully', async () => {
      mockWriteItems.mockImplementation((_names: unknown, _values: unknown, cb: Function) => {
        cb();
      });

      await backend.write([
        {
          name: 'temp',
          address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
          nodes7Address: 'DB1,REAL0',
          value: 25.5,
        },
      ]);

      expect(mockWriteItems).toHaveBeenCalled();
    });

    it('handles write error', async () => {
      mockWriteItems.mockImplementation((_n: unknown, _v: unknown, cb: Function) => {
        cb(new Error('Write failed'));
      });

      await expect(
        backend.write([
          {
            name: 'temp',
            address: { area: 'DB', dbNumber: 1, dataType: 'REAL', offset: 0, bitOffset: 0 },
            nodes7Address: 'DB1,REAL0',
            value: 25.5,
          },
        ]),
      ).rejects.toThrow('nodes7 write failed');
    });

    it('names the written addresses when nodes7 reports bad quality', async () => {
      mockWriteItems.mockImplementation((_n: unknown, _v: unknown, cb: Function) => cb(true));

      await expect(
        backend.write([
          {
            name: 'a',
            address: { area: 'DB', dbNumber: 6, dataType: 'INT', offset: 0, bitOffset: 0 },
            nodes7Address: 'DB6,INT0',
            value: 1,
          },
          {
            name: 'b',
            address: { area: 'DB', dbNumber: 6, dataType: 'INT', offset: 2, bitOffset: 0 },
            nodes7Address: 'DB6,INT2',
            value: 2,
          },
        ]),
      ).rejects.toThrow('nodes7 write failed: bad quality for DB6,INT0, DB6,INT2 (');
    });
  });

  describe('browse methods', () => {
    it('listBlocks throws (not supported)', async () => {
      await expect(backend.listBlocks()).rejects.toThrow('nodes7 does not support');
    });

    it('listBlocksOfType throws', async () => {
      await expect(backend.listBlocksOfType('DB')).rejects.toThrow('nodes7 does not support');
    });

    it('getBlockInfo throws', async () => {
      await expect(backend.getBlockInfo('DB', 1)).rejects.toThrow('nodes7 does not support');
    });

    it('readSZL throws', async () => {
      await expect(backend.readSZL(0, 0)).rejects.toThrow('nodes7 does not support');
    });
  });
});
