export type ApprovalErrorCode = 'UNSUPPORTED_PLATFORM' | 'UNSUPPORTED_LINK' | 'UNSUPPORTED_VERSION' |
  'UNSAFE_PATH' | 'IO_ERROR' | 'CORRUPT_RECORD' | 'CORRUPT_STATE' | 'CORRUPT_HIGH_WATER' |
  'PAYLOAD_MISMATCH' | 'SOURCE_MISMATCH' | 'SEQUENCE_OVERFLOW' | 'INVALID_INPUT';

/** Approval failures carry a safe diagnostic; never include payloads or secrets. */
export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
    readonly path: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApprovalError';
  }
}
