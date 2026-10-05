import { NodeMessage } from 'node-red';
import { ConnectionManager } from '../../../../src/core/connection-manager';
import { handleConnectionAction } from '../../../../src/nodes/shared/connection-action';
import { S7ConfigNode } from '../../../../src/nodes/s7-config/s7-config-types';
import { MockBackend } from '../../../helpers/mock-backend';

describe('handleConnectionAction', () => {
  let backend: MockBackend;
  let connection: ConnectionManager;
  let serverNode: S7ConfigNode;
  let send: jest.Mock;
  let done: jest.Mock;

  const make = (allowDynamic: boolean, configError: string | null = null) => {
    backend = new MockBackend();
    connection = new ConnectionManager(backend, {
      host: '10.0.0.1', port: 102, rack: 0, slot: 1, plcType: 'S7-1200', backend: 'nodes7',
      reconnectInterval: 10000, healthCheckInterval: 0,
    });
    serverNode = {
      name: 'Line 1 PLC',
      connectionManager: connection,
      allowDynamic,
      configError,
      getStatus: () => ({ ...connection.getStatus(), host: '10.0.0.1' }),
    } as unknown as S7ConfigNode;
    send = jest.fn();
    done = jest.fn();
  };
  // msg.s7 on an action's reply
  const details = (op: string) => ({
    op, server: 'Line 1 PLC', timestamp: expect.any(Number), durationMs: expect.any(Number),
  });
  const run = (msg: Record<string, unknown>) =>
    handleConnectionAction(serverNode, msg as NodeMessage, send, done);

  afterEach(async () => {
    await connection.disconnect();
  });

  it('leaves a message without an action to the node', async () => {
    make(true);
    expect(await run({ payload: 1 })).toBe(false);
    expect(await run({ payload: 1, action: '' })).toBe(false);
    expect(done).not.toHaveBeenCalled();
  });

  it('ignores msg.action while Dynamic control is off', async () => {
    make(false);
    expect(await run({ action: 'connect' })).toBe(false);
    expect(await run({ action: 'nonsense' })).toBe(false);
    expect(backend.connectCalls).toHaveLength(0);
    expect(done).not.toHaveBeenCalled();
  });

  it('refuses an unknown action', async () => {
    make(true);
    expect(await run({ action: 'restart' })).toBe(true);
    expect(done.mock.calls[0][0].message).toBe(
      'Invalid msg.action "restart". Expected one of: connect, disconnect, reconnect, status',
    );
    expect(await run({ action: 42 })).toBe(true);
    expect(done.mock.calls[1][0].message).toMatch(/^Invalid msg.action 42\./);
  });

  it('status sends the report as msg.payload, without msg.action, and does no I/O', async () => {
    make(true);
    await connection.connect();
    expect(await run({ action: 'status', topic: 'line1', payload: 'x' })).toBe(true);
    expect(send).toHaveBeenCalledWith({
      topic: 'line1',
      payload: expect.objectContaining({ state: 'connected', host: '10.0.0.1' }),
      s7: details('status'),
    });
    expect(done).toHaveBeenCalledWith();
    expect(backend.readCalls).toHaveLength(0);
  });

  it('connect connects, and is a success when already connected', async () => {
    make(true);
    expect(await run({ action: 'connect' })).toBe(true);
    expect(connection.getState()).toBe('connected');
    await run({ action: 'connect' });
    expect(backend.connectCalls).toHaveLength(1);
    expect(done.mock.calls).toEqual([[], []]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends the message on once connected, with the report as it is then', async () => {
    make(true);
    await run({ action: 'connect', topic: 'line1', payload: 'x' });
    expect(send).toHaveBeenCalledWith({
      topic: 'line1',
      payload: expect.objectContaining({ state: 'connected' }),
      s7: details('connect'),
    });
  });

  it('times the action', async () => {
    make(true);
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(5000).mockReturnValue(5030);
    await run({ action: 'reconnect' });
    now.mockRestore();
    expect(send.mock.calls[0][0].s7).toMatchObject({ op: 'reconnect', timestamp: 5030, durationMs: 30 });
  });

  it('reports a failed connect as the error, and sends nothing', async () => {
    make(true);
    backend.shouldFailConnect = true;
    await run({ action: 'connect' });
    expect(done.mock.calls[0][0].message).toBe('Connection failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('disconnect disconnects and stops retrying', async () => {
    make(true);
    await connection.connect();
    await run({ action: 'disconnect' });
    expect(connection.getState()).toBe('disconnected');
    expect(send).toHaveBeenCalledWith({
      payload: expect.objectContaining({ state: 'disconnected' }),
      s7: details('disconnect'),
    });
    expect(done).toHaveBeenCalledWith();
  });

  it('reconnect disconnects then connects', async () => {
    make(true);
    await connection.connect();
    await run({ action: 'reconnect' });
    expect(connection.getState()).toBe('connected');
    expect(backend.connectCalls).toHaveLength(2);
    expect(send).toHaveBeenCalledWith({
      payload: expect.objectContaining({ state: 'connected' }),
      s7: details('reconnect'),
    });
    expect(done).toHaveBeenCalledWith();
  });

  it('names the server by host and port when the s7-config has no name', async () => {
    make(true);
    Object.assign(serverNode, { name: '', s7Config: { host: '10.0.0.1', port: 102 } });
    await run({ action: 'status' });
    expect(send.mock.calls[0][0].s7.server).toBe('10.0.0.1:102');
  });

  it('refuses to connect with settings that cannot be used', async () => {
    make(true, 'host: environment variable "PLC_HOST" is not set');
    await run({ action: 'connect' });
    await run({ action: 'reconnect' });
    expect(done.mock.calls[0][0].message).toBe('Invalid S7 config: host: environment variable "PLC_HOST" is not set');
    expect(done.mock.calls[1][0].message).toMatch(/^Invalid S7 config/);
    expect(backend.connectCalls).toHaveLength(0);
  });
});
