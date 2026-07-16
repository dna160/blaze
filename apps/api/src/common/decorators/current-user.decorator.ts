import { createParamDecorator, type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import type { AuthenticatedUser } from "../types/express-request.js";

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});
