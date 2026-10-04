import { Node } from 'node-red';
import { ConnectionManager } from '../../core/connection-manager';
import { S7ConnectionConfig, ConnectionStatus } from '../../types/s7-connection';

export interface S7ConfigNode extends Node {
  connectionManager: ConnectionManager;
  s7Config: S7ConnectionConfig;
  /** Connect on deploy and retry after a failure or a lost link. */
  autoConnect: boolean;
  /** Nodes using this connection accept msg.action (connect, disconnect, reconnect, status). */
  allowDynamic: boolean;
  /** Why the settings can't be used (an unset environment variable, a bad port), or null. */
  configError: string | null;
  /** The connection's state and settings, as msg.action "status" sends them. */
  getStatus(): S7ConnectionReport;
  registerChildNode(node: Node): void;
  deregisterChildNode(node: Node): void;
}

export interface S7ConnectionReport extends ConnectionStatus {
  id: string;
  name: string | null;
  backend: S7ConnectionConfig['backend'];
  host: string;
  port: number;
  rack: number;
  slot: number;
  plcType: S7ConnectionConfig['plcType'];
  autoConnect: boolean;
  allowDynamic: boolean;
  configError: string | null;
}
