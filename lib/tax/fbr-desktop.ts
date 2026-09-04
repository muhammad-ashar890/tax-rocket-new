import { createHash, randomBytes } from "crypto";

export function generateLaunchToken(): string {
  return randomBytes(32).toString("hex"); // 64 chars
}

export function generatePartitionKey(userId: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `fbr-iris-${userId.slice(0, 8)}-${suffix}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateDeviceId(): string {
  return `dev_${randomBytes(8).toString("hex")}`;
}

export type DesktopSessionConfig = {
  launchToken: string;
  partitionKey: string;
  deviceTokenHash: string;
  deepLink: string;
  localhostUrl: string;
  expiresAt: string;
  irisLoginUrl: string;
  irisReadySelector: string;
  readyUrlPattern: string;
};

export function buildDesktopSessionConfig(params: {
  launchToken: string;
  partitionKey: string;
  deviceTokenHash: string;
}): DesktopSessionConfig {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  
  return {
    launchToken: params.launchToken,
    partitionKey: params.partitionKey,
    deviceTokenHash: params.deviceTokenHash,
    deepLink: `taxrocket-connect://connect?token=${params.launchToken}&partition=${params.partitionKey}&apiBaseUrl=${encodeURIComponent(baseUrl)}&baseUrl=${encodeURIComponent(baseUrl)}&flow=fbr`,
    localhostUrl: `http://127.0.0.1:37219/connect?token=${params.launchToken}&partition=${params.partitionKey}&apiBaseUrl=${encodeURIComponent(baseUrl)}&flow=fbr`,
    expiresAt,
    irisLoginUrl: process.env.FBR_IRIS_LOGIN_URL || "https://iris.fbr.gov.pk/login",
    irisReadySelector: process.env.FBR_IRIS_READY_SELECTOR || "body",
    readyUrlPattern: process.env.FBR_IRIS_READY_URL_PATTERN || "iris.fbr.gov.pk",
  };
}

export const JOB_TYPES = {
  TAX_DRY_RUN: "tax_dry_run",
  TAX_ASSISTED_FILING: "tax_assisted_filing",
} as const;

export const JOB_STATUSES = {
  CREATED: "created",
  OFFERED_TO_DEVICE: "offered_to_device",
  ACCEPTED_BY_DEVICE: "accepted_by_device",
  RUNNING: "running",
  AWAITING_USER_ACTION: "awaiting_user_action",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const;

export const PAUSE_ACTIONS = {
  OTP: "otp_required",
  CAPTCHA: "captcha_required",
  PIN: "pin_required",
  CLASSIC_PIN_ENTRY: "classic_pin_entry", // legacy naming from worker.md
  PSID: "psid_payment",
  FINAL_REVIEW: "final_review",
  CLASSIC_FINAL_REVIEW: "classic_final_review", // legacy
  PAYMENT: "payment_required",
} as const;

export function isValidPauseAction(action: string): boolean {
  return Object.values(PAUSE_ACTIONS).includes(action as any) || 
         ["classic_final_review", "classic_pin_entry", "otp", "captcha", "pin", "psid", "final_review"].includes(action);
}

export function normalizePauseAction(action: string): string {
  const mapping: Record<string, string> = {
    classic_final_review: PAUSE_ACTIONS.FINAL_REVIEW,
    classic_pin_entry: PAUSE_ACTIONS.PIN,
    otp: PAUSE_ACTIONS.OTP,
    captcha: PAUSE_ACTIONS.CAPTCHA,
    pin: PAUSE_ACTIONS.PIN,
    psid: PAUSE_ACTIONS.PSID,
    final_review: PAUSE_ACTIONS.FINAL_REVIEW,
  };
  return mapping[action] || action;
}
