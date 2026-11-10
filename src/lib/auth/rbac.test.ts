import { describe, expect, it } from "vitest";
import { ForbiddenError, ROLES, assertCan, can, isRole, toRole } from "./rbac";

const alice = { id: "alice", role: "user" as const };
const bob = { id: "bob", role: "user" as const };
const admin = { id: "root", role: "admin" as const };
const agent = { id: "ag", role: "agent" as const };

describe("can", () => {
  it("lets any signed-in user create", () => {
    expect(can(alice, "create")).toBe(true);
  });

  it("lets owners read, update and delete their own resources", () => {
    const mine = { ownerId: "alice" };
    for (const action of ["read", "update", "delete"] as const) {
      expect(can(alice, action, mine)).toBe(true);
    }
  });

  it("blocks users from other users' resources", () => {
    const hers = { ownerId: "alice" };
    for (const action of ["read", "update", "delete"] as const) {
      expect(can(bob, action, hers)).toBe(false);
    }
  });

  it("denies non-create actions when no resource is given", () => {
    expect(can(alice, "delete")).toBe(false);
  });

  it("lets admins do anything", () => {
    expect(can(admin, "delete", { ownerId: "alice" })).toBe(true);
  });
});

describe("assertCan", () => {
  it("throws ForbiddenError with status 403", () => {
    expect(() => assertCan(bob, "delete", { ownerId: "alice" })).toThrow(ForbiddenError);
  });
});

describe("toRole", () => {
  it("defaults to user", () => {
    expect(toRole(null)).toBe("user");
    expect(toRole("")).toBe("user");
    expect(toRole("viewer")).toBe("user");
  });

  it("reads admin from a comma-separated list", () => {
    expect(toRole("user, admin")).toBe("admin");
  });

  it("returns exactly one role: admin over agent over user", () => {
    expect(toRole("agent")).toBe("agent");
    expect(toRole("user,agent")).toBe("agent");
    expect(toRole("agent,admin")).toBe("admin");
    expect(toRole("admin,agent,user")).toBe("admin");
  });

  it("treats an unknown role name as a customer", () => {
    expect(toRole("superuser")).toBe("user");
    expect(toRole("Agent")).toBe("user");
  });
});

describe("agent role", () => {
  it("is one of the three roles", () => {
    expect([...ROLES]).toEqual(["user", "agent", "admin"]);
    expect(isRole("agent")).toBe(true);
    expect(isRole("underwriter")).toBe(false);
  });

  it("gets no template ownership shortcut (tickets use src/lib/access.ts, not can())", () => {
    // The template's can() lets admins through; an agent is only an owner of their own rows.
    expect(can(agent, "read", { ownerId: "someone-else" })).toBe(false);
  });
});
