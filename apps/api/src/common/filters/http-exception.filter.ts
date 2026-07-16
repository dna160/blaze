import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";

import { GuardFailedError, IllegalTransitionError } from "@rentos/domain";

/**
 * Translates domain-layer state-machine errors into HTTP responses at the
 * one place they cross the boundary, so booking/finance/asset services
 * never need to know about HTTP status codes (PRD §11 module boundaries —
 * @rentos/domain has zero framework dependencies).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === "string" ? { code: "ERROR", message: body } : body);
      return;
    }

    if (exception instanceof GuardFailedError) {
      res.status(HttpStatus.CONFLICT).json({ code: "GUARD_FAILED", message: exception.message });
      return;
    }

    if (exception instanceof IllegalTransitionError) {
      res.status(HttpStatus.CONFLICT).json({ code: "ILLEGAL_TRANSITION", message: exception.message });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: "INTERNAL_ERROR", message: "Unexpected error." });
  }
}
