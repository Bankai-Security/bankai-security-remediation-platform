import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/http-error.js";
import { validateBody } from "./validate-body.js";

const schema = z.object({ name: z.string().trim().min(1), count: z.coerce.number().int().positive() });

describe("validateBody", () => {
  it("replaces the request body with validated, normalized data", () => {
    const req = { body: { name: "  scan  ", count: "2", ignored: true } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    validateBody(schema)(req, {} as Response, next);
    expect(req.body).toEqual({ name: "scan", count: 2 });
    expect(next).toHaveBeenCalledWith();
  });

  it("returns field-safe validation details without echoing request values", () => {
    const req = { body: { name: "", count: "secret-value" } } as unknown as Request;
    const next = vi.fn();
    validateBody(schema)(req, {} as Response, next as unknown as NextFunction);
    const error = next.mock.calls[0]?.[0] as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.statusCode).toBe(422);
    expect(error.message).toBe("Invalid request data");
    expect(JSON.stringify(error.details)).not.toContain("secret-value");
  });
});
