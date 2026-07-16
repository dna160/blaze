import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * Every request body/query in this API is validated against the same zod
 * schemas @rentos/contracts exports for the frontends — one schema, two
 * consumers (runtime validation here, compile-time types on the client),
 * so the contract cannot drift between them.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Request failed validation.",
        details: result.error.flatten(),
      });
    }
    return result.data;
  }
}
