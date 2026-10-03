import { EventEmitter } from 'events';
import { IS7Backend } from '../backend/s7-backend.interface';
import { S7ConnectionConfig, ConnectionState } from '../types/s7-connection';
import { S7ReadItem, S7ReadResult, S7WriteItem } from '../types/s7-address';
import { S7Error, S7ErrorCode } from '../utils/error-codes';

interface QueueEntry {
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class ConnectionManager extends EventEmitter {
  private backend: IS7Backend;
  private config: S7ConnectionConfig;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private queue: QueueEntry[] = [];
  private processing = false;
  private maxQueueSize = 100;
  private manualDisconnect = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: number;
  private lastActivity = 0;

  constructor(backend: IS7Backend, config: S7ConnectionConfig, maxQueueSize = 100) {
    super();
    this.setMaxListeners(50);
    this.backend = backend;
    this.config = config;
    this.maxQueueSize = maxQueueSize;
    this.reconnectDelay = config.reconnectInterval ?? 1000;
    this.healthCheckInterval = config.healthCheckInterval ?? 2000;
  }

  /** Returns the current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Establishes a connection to the PLC, scheduling reconnection on failure. */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;

    this.manualDisconnect = false;
    this.setState('connecting');

    try {
      await this.backend.connect(this.config);
      this.setState('connected');
      this.reconnectDelay = this.config.reconnectInterval ?? 1000;
    } catch (err) {
      this.setState('error');
      this.scheduleReconnect();
      throw err;
    }
  }

  /** Disconnects from the PLC, cancelling any pending reconnect and draining the queue. */
  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.rejectPendingQueue();

    // Always let the backend clean up: after a lost link isConnected() is false, but the
    // library may still hold a socket or its own reconnect timers.
    await this.backend.disconnect();
    this.setState('disconnected');
  }

  /** Queues a read request for one or more S7 items. */
  async read(items: S7ReadItem[]): Promise<S7ReadResult[]> {
    return this.enqueue(() => this.backend.read(items)) as Promise<S7ReadResult[]>;
  }

  /** Queues a write request for one or more S7 items. */
  async write(items: S7WriteItem[]): Promise<void> {
    return this.enqueue(() => this.backend.write(items)) as Promise<void>;
  }

  /** Queues a raw memory area read from the PLC. */
  async readRawArea(area: number, dbNumber: number, start: number, length: number): Promise<Buffer> {
    return this.enqueue(() => this.backend.readRawArea(area, dbNumber, start, length)) as Promise<Buffer>;
  }

  /** Returns the underlying S7 backend instance. */
  getBackend(): IS7Backend {
    return this.backend;
  }

  private enqueue(execute: () => Promise<unknown>): Promise<unknown> {
    if (this.state !== 'connected') {
      return Promise.reject(new S7Error(S7ErrorCode.DISCONNECTED, 'Not connected'));
    }

    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new S7Error(S7ErrorCode.QUEUE_FULL, 'Request queue is full'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ execute, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = this.config.requestTimeout ?? 3000;
        const result = await Promise.race([
          entry.execute(),
          new Promise((_resolve, reject) => {
            timeoutHandle = setTimeout(() => reject(new S7Error(S7ErrorCode.REQUEST_TIMEOUT, 'Request timed out')), timeoutMs);
          }),
        ]);
        this.lastActivity = Date.now();
        entry.resolve(result);
      } catch (err) {
        entry.reject(err);
        if (this.isConnectionError(err)) {
          this.handleConnectionLoss();
          break;
        }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }

    this.processing = false;
  }

  private handleConnectionLoss(): void {
    this.setState('reconnecting');
    this.rejectPendingQueue();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect) return;
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(async () => {
      if (this.manualDisconnect) return;
      try {
        this.setState('connecting');
        await this.backend.connect(this.config);
        if (this.manualDisconnect) {
          // disconnect() was called while the reconnect attempt was in flight
          await this.backend.disconnect();
          this.setState('disconnected');
          return;
        }
        this.setState('connected');
        this.reconnectDelay = this.config.reconnectInterval ?? 1000;
      } catch {
        this.setState('error');
        // Exponential backoff
        const maxDelay = this.config.maxReconnectInterval ?? 30000;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, maxDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectPendingQueue(): void {
    const pending = this.queue.splice(0);
    for (const entry of pending) {
      entry.reject(new S7Error(S7ErrorCode.DISCONNECTED, 'Connection lost'));
    }
    this.processing = false;
  }

  private setState(newState: ConnectionState): void {
    const oldState = this.state;
    this.state = newState;
    if (newState === 'connected') {
      this.startHealthCheck();
    } else {
      this.stopHealthCheck();
    }
    if (oldState !== newState) {
      this.emit('stateChanged', { oldState, newState });
    }
  }

  /**
   * While connected and idle, check the link every healthCheckInterval ms so a lost PLC shows
   * up without waiting for the next read or write. Any successful request counts as a check.
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval <= 0 || this.healthTimer) return;
    this.lastActivity = Date.now();
    this.healthTimer = setInterval(() => this.checkHealth(), this.healthCheckInterval);
    this.healthTimer.unref?.();
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private checkHealth(): void {
    if (this.state !== 'connected') return;

    // Free check (no traffic), so run it every tick
    if (!this.backend.isConnected()) {
      this.handleConnectionLoss();
      return;
    }

    // Only ping when idle; a recent successful request already proves the link
    if (this.processing || this.queue.length > 0) return;
    if (Date.now() - this.lastActivity < this.healthCheckInterval) return;
    if (this.backend.ping) {
      // Goes through the queue like any request; a connection-class failure triggers the
      // usual reconnect in processQueue(). Other failures (e.g. a PLC that rejects the
      // status request) are ignored.
      this.enqueue(() => this.backend.ping!()).catch(() => undefined);
    }
  }

  private isConnectionError(err: unknown): boolean {
    if (err instanceof S7Error) {
      return (
        err.code === S7ErrorCode.CONNECTION_FAILED ||
        err.code === S7ErrorCode.DISCONNECTED ||
        err.code === S7ErrorCode.CONNECTION_TIMEOUT ||
        err.code === S7ErrorCode.REQUEST_TIMEOUT
      );
    }
    return false;
  }
}
