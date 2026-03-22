export * from './roles';
export * from './events';

export const PLATFORM_FEE_RATE = 0.15; // 15% home services commission
export const TENDER_COMMISSION_RATE = 0.02; // 2% tender commission
export const EQUIPMENT_FEE_RATE = 0.1; // 10% equipment rental commission
export const REFERRAL_REWARD_SAR = 50; // SAR 50 per referral
export const ESCROW_HOLD_HOURS = 48; // hours before auto-release
export const EMAIL_VERIFY_TTL_HOURS = 24; // email verification link TTL
export const PASSWORD_RESET_TTL_MIN = 60; // password reset link TTL (minutes)
export const JWT_ACCESS_EXPIRE = '15m';
export const JWT_REFRESH_EXPIRE = '30d';
