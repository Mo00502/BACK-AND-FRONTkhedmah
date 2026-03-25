export const PAYOUT_QUEUE = 'payout';

export interface PayoutJobData {
  payoutId: string;
  attempt: number;
}
