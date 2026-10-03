export enum S7ErrorCode {
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  DISCONNECTED = 'DISCONNECTED',
  READ_FAILED = 'READ_FAILED',
  WRITE_FAILED = 'WRITE_FAILED',
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  INVALID_DATA_TYPE = 'INVALID_DATA_TYPE',
  BACKEND_NOT_AVAILABLE = 'BACKEND_NOT_AVAILABLE',
  BROWSE_FAILED = 'BROWSE_FAILED',
  RATE_LIMITED = 'RATE_LIMITED',
  QUEUE_FULL = 'QUEUE_FULL',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  CONTROL_FAILED = 'CONTROL_FAILED',
}

/**
 * Readable text for whatever a PLC library passed as its error. nodes7 and node-snap7 often
 * pass a string, a boolean or a numeric code rather than an Error.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const RAW_AREA_NAMES: Record<number, string> = { 0x81: 'I', 0x82: 'Q', 0x83: 'M', 0x1c: 'C', 0x1d: 'T' };

/** Describes a raw area request for error messages, e.g. "8 bytes at DB1 offset 200". */
export function describeRawRequest(area: number, dbNumber: number, start: number, length: number): string {
  const where = area === 0x84 ? `DB${dbNumber}` : `area ${RAW_AREA_NAMES[area] ?? `0x${area.toString(16)}`}`;
  return `${length} byte${length === 1 ? '' : 's'} at ${where} offset ${start}`;
}

export class S7Error extends Error {
  constructor(
    public readonly code: S7ErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'S7Error';
  }
}
