import { Int64Mode } from './s7-address';

export type PlcType ='S7-200' | 'S7-300' | 'S7-400' | 'S7-1200' | 'S7-1500' | 'LOGO';

export type BackendType = 'nodes7' | 'snap7' | 'sim';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface S7ConnectionConfig {
  host: string;
  port: number;
  rack: number;
  slot: number;
  plcType: PlcType;
  backend: BackendType;
  localTSAP?: number;
  remoteTSAP?: number;
  password?: string;
  connectionTimeout?: number;
  requestTimeout?: number;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  /**
   * How often (ms) to check the link while connected and idle, so a lost PLC is noticed without
   * waiting for the next request. Defaults to 2000; 0 disables the check.
   */
  healthCheckInterval?: number;
  /**
   * When true, enables verbose backend protocol logging (nodes7 trace output).
   * Defaults to false so normal poll/read traffic is not logged to stdout.
   */
  debug?: boolean;
  /** How LINT and ULINT values are returned. Defaults to 'number'. */
  int64As?: Int64Mode;
}

export const PLC_DEFAULT_SLOTS: Record<PlcType, number> = {
  'S7-200': 1,
  'S7-300': 2,
  'S7-400': 3,
  'S7-1200': 1,
  'S7-1500': 1,
  'LOGO': 1,
};
