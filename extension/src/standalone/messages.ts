import type { GoogleProfile } from "@auth/core";
import { VaultError } from "./types";

/** Popup nhờ service worker đăng nhập Google (popup sẽ bị đóng khi cửa sổ đăng nhập mở ra). */
export const SIGN_IN_MESSAGE = "google-sign-in";

export type SignInResponse =
  | { ok: true; profile: GoogleProfile }
  | { ok: false; error: { code: string; message: string } };

export async function requestSignIn(): Promise<GoogleProfile> {
  const response = (await chrome.runtime.sendMessage({ type: SIGN_IN_MESSAGE })) as
    | SignInResponse
    | undefined;
  if (!response) throw new VaultError("GOOGLE_AUTH_FAILED", "Không đăng nhập được Google.");
  if (!response.ok) throw new VaultError(response.error.code, response.error.message);
  return response.profile;
}
