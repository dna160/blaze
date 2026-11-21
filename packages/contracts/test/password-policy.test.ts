import { describe, expect, it } from "vitest";

import { checkPasswordPolicy, passwordPolicyError, PASSWORD_MIN_LENGTH } from "../src/password-policy.js";

const who = { email: "risa.finance@example.test", displayName: "Risa Wulandari" };

describe("checkPasswordPolicy", () => {
  it("accepts a long passphrase with no composition rules", () => {
    expect(checkPasswordPolicy("gudang biru lantai tiga", who)).toEqual([]);
    expect(checkPasswordPolicy("Tr4nsfer-Mutasi-Senin", who)).toEqual([]);
  });

  it(`wants at least ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(checkPasswordPolicy("pendek-9c", who)).toContain("TOO_SHORT");
    expect(checkPasswordPolicy("pendek-10c", who)).not.toContain("TOO_SHORT");
    expect(checkPasswordPolicy("x1".repeat(101), who)).toContain("TOO_LONG");
  });

  it("refuses the user's own email or name, whatever the case or spacing", () => {
    expect(checkPasswordPolicy("risa.finance@example.test", who)).toContain("SAME_AS_IDENTITY");
    expect(checkPasswordPolicy("RISA.FINANCE", { email: "risa.finance@example.test" })).toContain("SAME_AS_IDENTITY");
    expect(checkPasswordPolicy("Risa Wulandari", who)).toContain("SAME_AS_IDENTITY");
    expect(checkPasswordPolicy("risawulandari", who)).toContain("SAME_AS_IDENTITY");
    // Somebody else's name is just a string.
    expect(checkPasswordPolicy("Risa Wulandari", { email: "tiara@example.test", displayName: "Tiara" })).toEqual([]);
  });

  it("refuses the passwords everyone tries first, with or without a number on the end", () => {
    const common = [
      "password123",
      "Password2026!",
      "1234567890",
      "0987654321",
      "12345678901234",
      "qwertyuiop",
      "citystorage1",
      "City Storage 2026",
      "kebonjeruk01",
      "RentOS!Demo2026",
      "aaaaaaaaaaaa",
      "abc1234567",
    ];
    for (const p of common) expect(checkPasswordPolicy(p, who), p).toContain("TOO_COMMON");
  });

  it("does not call an ordinary number-heavy password common", () => {
    expect(checkPasswordPolicy("4815162342-loker", who)).toEqual([]);
    expect(checkPasswordPolicy("8301947265", who)).toEqual([]);
  });

  it("works without knowing who the user is", () => {
    expect(checkPasswordPolicy("gudang biru lantai tiga")).toEqual([]);
    expect(checkPasswordPolicy("")).toEqual(["TOO_SHORT"]);
  });
});

describe("passwordPolicyError", () => {
  it("is one bilingual line, Indonesian first, or null", () => {
    expect(passwordPolicyError("gudang biru lantai tiga", who)).toBeNull();
    expect(passwordPolicyError("short", who)).toBe("Kata sandi minimal 10 karakter. / Use at least 10 characters.");
  });
});
