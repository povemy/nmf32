import { destroySession } from "@/lib/auth";
import { handle, ok } from "@/lib/api";
import type { LogoutData } from "@/lib/types/api-contract";

export const POST = handle(async () => {
  await destroySession();
  const payload: LogoutData = { loggedOut: true };
  return ok(payload);
});
