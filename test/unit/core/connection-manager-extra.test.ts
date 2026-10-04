import { ConnectionManager } from '../../../src/core/connection-manager';
import { MockBackend } from '../../helpers/mock-backend';
import { S7ConnectionConfig } from '../../../src/types/s7-connection';
import { S7Error, S7ErrorCode } from '../../../src/utils/error-codes';

describe('ConnectionManager - extra coverage', () => {
  let backend: MockBackend;
  let manager: ConnectionManager;
  const config: S7ConnectionConfig = {
    host: '192.168.1.100',
    port: 102,
    rack: 0,
    slot: 1,
    plcType: 'S7-1200',
    backend: 'nodes7',
    reconnectInterval: 50,
    maxReconnectInterval: 200,
  };

  beforeEach(() => {
    backend = new MockBackend();
    manager = new ConnectionManager(backend, config);
  });

  afterEach(async () => {
    await manager.disconnect();
  });

  it('does nothing when already connected', async () => {
    await manager.connect();
    await manager.connect(); // second call should be no-op
    expect(backend.connectCalls.length).toBe(1);
  });

  it('rejects write when disconnected', async () => {
    await expect(
      manager.write([{
        name: 'x',
        address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 0, bitOffset: 0 },
        value: 1,
      }]),
    ).rejects.toThrow('Not connected');
  });

  it('rejects readRawArea when disconnected', async () => {
    await expect(manager.readRawArea(0x84, 1, 0, 4)).rejects.toThrow('Not connected');
  });

  it('readRawArea works when connected', async () => {
    backend.rawAreaData.set('132:1:0:4', Buffer.from([0, 0, 0, 0]));
    await manager.connect();
    const buf = await manager.readRawArea(0x84, 1, 0, 4);
    expect(buf.length).toBe(4);
  });

  it('returns backend via getBackend', () => {
    expect(manager.getBackend()).toBe(backend);
  });

  it('handles connection error during read and reconnects', async () => {
    await manager.connect();

    // Make read throw a connection error
    backend.read = async () => {
      throw new S7Error(S7ErrorCode.CONNECTION_FAILED, 'Connection lost');
    };

    await expect(
      manager.read([{
        name: 'x',
        address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 0, bitOffset: 0 },
      }]),
    ).rejects.toThrow('Connection lost');

    expect(manager.getState()).toBe('reconnecting');

    // Allow reconnect
    backend.read = new MockBackend().read.bind(new MockBackend());
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.getState()).toBe('connected');
  });

  it('rejects pending queue items when connection is lost', async () => {
    await manager.connect();

    // Slow read + connection error
    let callCount = 0;
    backend.read = async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise((r) => setTimeout(r, 50));
        throw new S7Error(S7ErrorCode.DISCONNECTED, 'Disconnected');
      }
      return [];
    };

    const item = {
      name: 'x',
      address: { area: 'DB' as const, dbNumber: 1, dataType: 'INT' as const, offset: 0, bitOffset: 0 },
    };

    const p1 = manager.read([item]);
    const p2 = manager.read([item]);

    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow('Connection lost');
  });

  it('handles non-S7Error during read without triggering reconnect', async () => {
    await manager.connect();

    backend.read = async () => {
      throw new Error('Generic error');
    };

    await expect(
      manager.read([{
        name: 'x',
        address: { area: 'DB', dbNumber: 1, dataType: 'INT', offset: 0, bitOffset: 0 },
      }]),
    ).rejects.toThrow('Generic error');

    // State should still be connected (not reconnecting)
    expect(manager.getState()).toBe('connected');
  });

  it('always asks the backend to clean up on disconnect, even after the link was lost', async () => {
    await manager.connect();
    backend.connected = false; // backend noticed the link went down
    const spy = jest.spyOn(backend, 'disconnect');
    await manager.disconnect();
    expect(spy).toHaveBeenCalled();
  });

  describe('idle health check', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let hcManager: ConnectionManager;
    let states: string[];

    const make = (healthCheckInterval: number) => {
      hcManager = new ConnectionManager(backend, { ...config, healthCheckInterval });
      states = [];
      hcManager.on('stateChanged', ({ newState }) => states.push(newState));
      return hcManager;
    };

    afterEach(async () => {
      await hcManager?.disconnect();
    });

    it('notices a lost link while idle and reconnects', async () => {
      await make(30).connect();
      backend.connected = false; // e.g. nodes7 saw the socket close

      await sleep(120);
      expect(states).toContain('reconnecting');

      // reconnectInterval is 50ms in this suite; MockBackend.connect() brings it back
      await sleep(120);
      expect(hcManager.getState()).toBe('connected');
      expect(backend.connectCalls.length).toBe(2);
    });

    it('pings an idle backend and reconnects when the ping reports a lost link', async () => {
      let pings = 0;
      backend.ping = async () => {
        pings++;
        throw new S7Error(S7ErrorCode.DISCONNECTED, 'link gone');
      };

      await make(30).connect();
      await sleep(120);

      expect(pings).toBeGreaterThan(0);
      expect(states).toContain('reconnecting');
    });

    it('ignores a ping failure that is not a lost link', async () => {
      backend.ping = async () => {
        throw new S7Error(S7ErrorCode.READ_FAILED, 'CPU does not support status requests');
      };

      await make(30).connect();
      await sleep(120);

      expect(states).not.toContain('reconnecting');
      expect(hcManager.getState()).toBe('connected');
    });

    it('does not check while requests keep the link busy', async () => {
      const ping = jest.fn(async () => undefined);
      backend.ping = ping;
      await make(40).connect();

      const item = {
        name: 'x',
        address: { area: 'DB' as const, dbNumber: 1, dataType: 'INT' as const, offset: 0, bitOffset: 0 },
      };
      for (let i = 0; i < 6; i++) {
        await hcManager.read([item]);
        await sleep(15);
      }

      expect(ping).not.toHaveBeenCalled();
    });

    it('notices a lost link on the next tick even right after a request', async () => {
      await make(40).connect();
      await hcManager.read([{
        name: 'x',
        address: { area: 'DB' as const, dbNumber: 1, dataType: 'INT' as const, offset: 0, bitOffset: 0 },
      }]);
      backend.connected = false;

      await sleep(60); // a single tick, not two
      expect(states).toContain('reconnecting');
    });

    it('can be disabled with healthCheckInterval 0', async () => {
      await make(0).connect();
      backend.connected = false;
      await sleep(100);
      expect(hcManager.getState()).toBe('connected');
    });
  });

  it('handles queue full scenario', async () => {
    await manager.connect();

    // Block the first read so the queue fills up
    let resolveFirst: (() => void) | null = null;
    let callCount = 0;
    backend.read = async (items) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      return items.map((i) => ({
        name: i.name,
        address: i.address,
        value: 0,
        quality: 'good' as const,
        timestamp: Date.now(),
      }));
    };

    const item = {
      name: 'x',
      address: { area: 'DB' as const, dbNumber: 1, dataType: 'INT' as const, offset: 0, bitOffset: 0 },
    };

    // Fill queue (100 items + 1 processing = 101, so 102 should overflow)
    const promises = [];
    for (let i = 0; i < 102; i++) {
      promises.push(manager.read([item]).catch((e) => e));
    }

    // Unblock
    resolveFirst!();

    const results = await Promise.all(promises);
    const queueFullErrors = results.filter(
      (r) => r instanceof S7Error && r.code === S7ErrorCode.QUEUE_FULL,
    );
    expect(queueFullErrors.length).toBeGreaterThan(0);
  });
});
