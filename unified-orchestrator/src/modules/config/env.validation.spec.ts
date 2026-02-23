import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { EnvironmentVariables } from "./env.validation";

function validate(input: Record<string, unknown>) {
  const instance = plainToInstance(EnvironmentVariables, input, {
    enableImplicitConversion: true,
  });
  return validateSync(instance, { skipMissingProperties: false });
}

const VALID_BASE = {
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://localhost/test",
  ADMIN_API_KEY: "a-very-long-admin-key-here",
  CORS_ORIGINS: "http://localhost:3001",
};

describe("EnvironmentVariables validation", () => {
  it("passes with all required vars present", () => {
    expect(validate(VALID_BASE)).toHaveLength(0);
  });

  it("fails when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _, ...rest } = VALID_BASE;
    const errors = validate(rest);
    expect(errors.some((e) => e.property === "DATABASE_URL")).toBe(true);
  });

  it("fails when ADMIN_API_KEY is missing", () => {
    const { ADMIN_API_KEY: _, ...rest } = VALID_BASE;
    const errors = validate(rest);
    expect(errors.some((e) => e.property === "ADMIN_API_KEY")).toBe(true);
  });

  it("fails when ADMIN_API_KEY is shorter than 16 chars", () => {
    const errors = validate({ ...VALID_BASE, ADMIN_API_KEY: "tooshort" });
    expect(errors.some((e) => e.property === "ADMIN_API_KEY")).toBe(true);
  });

  it("fails when CORS_ORIGINS is missing", () => {
    const { CORS_ORIGINS: _, ...rest } = VALID_BASE;
    const errors = validate(rest);
    expect(errors.some((e) => e.property === "CORS_ORIGINS")).toBe(true);
  });

  it("fails when NODE_ENV is an invalid value", () => {
    const errors = validate({ ...VALID_BASE, NODE_ENV: "banana" });
    expect(errors.some((e) => e.property === "NODE_ENV")).toBe(true);
  });

  it("fails when PORT is out of range", () => {
    const errors = validate({ ...VALID_BASE, PORT: "99999" });
    expect(errors.some((e) => e.property === "PORT")).toBe(true);
  });
});
