export const EVENTS = {
  // Auth
  EMAIL_VERIFICATION_REQUESTED: 'auth.email_verification_requested',
  LOGIN: 'auth.login',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET: 'auth.password_reset',
  PASSWORD_CHANGED: 'auth.password_changed',

  // Admin moderation
  ADMIN_USER_SUSPENDED: 'admin.user_suspended',
  ADMIN_USER_BANNED: 'admin.user_banned',

  // Escrow
  ESCROW_AUTO_RELEASED: 'escrow.auto_released',

  // Tender
  TENDER_AWARDED: 'tender.awarded',
  COMMISSIONS_OVERDUE: 'commissions.overdue_batch',

  // Equipment
  EQUIPMENT_BOOKED: 'equipment.booked',
  EQUIPMENT_RENTAL_STATUS: 'equipment.rental.status_changed',

  // Wallet
  WALLET_CREDITED: 'wallet.credited',
  WALLET_DEBITED: 'wallet.debited',
  WALLET_WITHDRAWAL_REQUESTED: 'wallet.withdrawal_requested',
  WALLET_WITHDRAWAL_APPROVED: 'wallet.withdrawal_approved',
  WALLET_WITHDRAWAL_REJECTED: 'wallet.withdrawal_rejected',
  WALLET_WITHDRAWAL_COMPLETED: 'wallet.withdrawal_completed',
  REFERRAL_REWARDED: 'referral.rewarded',

  // Requests lifecycle
  REQUEST_CREATED: 'request.created',
  REQUEST_STATUS_CHANGED: 'request.status_changed',
  REQUEST_COMPLETED: 'request.completed',
  QUOTE_SUBMITTED: 'quote.submitted',
  QUOTE_ACCEPTED: 'quote.accepted',

  // Reviews
  REVIEW_SUBMITTED: 'review.submitted',

  // Disputes
  DISPUTE_OPENED: 'dispute.opened',

  // Support
  SUPPORT_TICKET_OPENED: 'support.ticket_opened',

  // Materials payment
  MATERIALS_FUNDED: 'materials.payment.funded',
  MATERIALS_USAGE_LOGGED: 'materials.usage.logged',
  MATERIALS_USAGE_REJECTED: 'materials.usage.rejected',
  MATERIALS_ADJUSTMENT_REQUESTED: 'materials.adjustment.requested',
  MATERIALS_ADJUSTMENT_RESPONDED: 'materials.adjustment.responded',
  MATERIALS_RECONCILED_REFUND: 'materials.reconciled.refund',
  MATERIALS_REFUND_FULL: 'materials.refund.full',
  MATERIALS_ADJUSTMENT_EXPIRED: 'materials.adjustment.batch_expired',

  // Chat
  CHAT_MESSAGE_SENT: 'chat.message.sent',

  // Provider lifecycle
  PROVIDER_APPROVED: 'provider.approved',
  PROVIDER_REJECTED: 'provider.rejected',
} as const;
