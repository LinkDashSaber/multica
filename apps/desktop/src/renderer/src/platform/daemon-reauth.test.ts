import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetState, logout } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: { getState: mockGetState },
}));

import { reauthenticateDaemon } from "./daemon-reauth";

const daemonAPI = {
  clearToken: vi.fn(),
  syncToken: vi.fn(),
  restart: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  daemonAPI.clearToken.mockResolvedValue(undefined);
  daemonAPI.syncToken.mockResolvedValue(undefined);
  daemonAPI.restart.mockResolvedValue({ success: true });
  (window as unknown as { daemonAPI: typeof daemonAPI }).daemonAPI = daemonAPI;
  mockGetState.mockReturnValue({ user: { id: "user-1" }, logout });
});

describe("reauthenticateDaemon", () => {
  it("re-mints a fresh PAT and restarts the daemon when signed in", async () => {
    localStorage.setItem("multica_token", "jwt-abc");

    await reauthenticateDaemon();

    expect(daemonAPI.clearToken).toHaveBeenCalledOnce();
    expect(daemonAPI.syncToken).toHaveBeenCalledWith("jwt-abc", "user-1");
    expect(daemonAPI.restart).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
  });

  it("falls back to full logout when minting fails (session token is dead)", async () => {
    localStorage.setItem("multica_token", "jwt-abc");
    daemonAPI.syncToken.mockRejectedValueOnce(new Error("mint PAT failed: 401"));

    await reauthenticateDaemon();

    expect(logout).toHaveBeenCalledOnce();
    expect(daemonAPI.restart).not.toHaveBeenCalled();
  });

  it("logs out without touching the daemon when there is no session token", async () => {
    await reauthenticateDaemon();

    expect(logout).toHaveBeenCalledOnce();
    expect(daemonAPI.clearToken).not.toHaveBeenCalled();
    expect(daemonAPI.syncToken).not.toHaveBeenCalled();
  });

  it("logs out when there is no signed-in user", async () => {
    localStorage.setItem("multica_token", "jwt-abc");
    mockGetState.mockReturnValue({ user: null, logout });

    await reauthenticateDaemon();

    expect(logout).toHaveBeenCalledOnce();
    expect(daemonAPI.clearToken).not.toHaveBeenCalled();
  });
});
