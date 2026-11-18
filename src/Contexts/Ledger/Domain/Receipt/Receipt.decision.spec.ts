import { NotAllowedException } from '@Architecture/Domain';

import { ExpenseHasFormerMemberException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

import { AttachReceiptAccess, decideAttachReceipt } from './Receipt.decision';
import { InvalidReceiptException } from './ReceiptExceptions';
import { MAX_RECEIPT_BYTES, readReceiptFile } from './ReceiptFile';

const JPEG_START = [0xff, 0xd8, 0xff, 0xe0];
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file of `size` bytes that starts with `start`. */
const fileStarting = (start: number[], size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(start);
  return bytes;
};

/** Ada paid an expense split between herself and Bo; Cy is the group's owner in the rules below and Ada is the payer. */
const access: AttachReceiptAccess = {
  expense: {
    paidBy: 'ada',
    shares: [
      { memberId: 'ada', amount: 50 },
      { memberId: 'bo', amount: 50 },
    ],
  },
  memberIds: ['ada', 'bo', 'cy'],
  ownerId: 'cy',
};
const now = new Date('2026-11-18T10:00:00Z');

describe('attaching a receipt', () => {
  it('lets the payer attach a JPEG and answers its type and size, read from its first bytes', () => {
    const result = decideAttachReceipt(access, { by: 'ada', bytes: fileStarting(JPEG_START, 100) }, now);
    expect(result.isFailure()).toBe(false);
    expect(result.data?.state).toEqual({ type: 'image/jpeg', size: 100 });
  });

  it('lets the owner attach a PNG to an expense another member paid', () => {
    const result = decideAttachReceipt(access, { by: 'cy', bytes: fileStarting(PNG_START, 40) }, now);
    expect(result.data?.state).toEqual({ type: 'image/png', size: 40 });
  });

  it('refuses a member who is neither the payer nor the owner, as the Expense refuses a change by them', () => {
    const result = decideAttachReceipt(access, { by: 'bo', bytes: fileStarting(JPEG_START, 10) }, now);
    expect(result.isFailure()).toBe(true);
    expect(result.error).toBeInstanceOf(NotAllowedException);
  });

  it('refuses an expense that has a former member among its payer or its split', () => {
    const result = decideAttachReceipt(
      { ...access, memberIds: ['ada', 'cy'] },
      { by: 'ada', bytes: fileStarting(JPEG_START, 10) },
      now,
    );
    expect(result.error).toBeInstanceOf(ExpenseHasFormerMemberException);
  });

  it('refuses an empty file, a file neither a JPEG nor a PNG, and a file larger than 2 MB', () => {
    const refused = (bytes: Uint8Array) => {
      const result = decideAttachReceipt(access, { by: 'ada', bytes }, now);
      return result.isFailure() && result.error instanceof InvalidReceiptException;
    };
    expect(refused(new Uint8Array(0))).toBe(true);
    expect(refused(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true);
    expect(refused(fileStarting([0xff, 0xd8, 0x00], 10))).toBe(true);
    expect(refused(fileStarting(JPEG_START, MAX_RECEIPT_BYTES + 1))).toBe(true);
  });

  it('allows a file of exactly 2 MB, and refuses a one-byte file, which no JPEG or PNG is', () => {
    expect(readReceiptFile(fileStarting(JPEG_START, MAX_RECEIPT_BYTES)).data).toEqual({
      type: 'image/jpeg',
      size: MAX_RECEIPT_BYTES,
    });
    expect(readReceiptFile(Uint8Array.from([0xff])).isFailure()).toBe(true);
  });
});
