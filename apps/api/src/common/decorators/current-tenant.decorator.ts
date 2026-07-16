import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/**
 * The single sanctioned way a handler learns which tenant it's operating
 * for. Prefers req.user.tenantId (signed JWT, authoritative) over
 * req.tenant (Host-header resolution) — once authenticated, the client
 * cannot influence tenant scope by editing a header. Throws rather than
 * returning undefined so a missing tenant fails loudly at the boundary
 * instead of silently reaching a service method.
 */
export const CurrentTenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const tenantId = req.user?.tenantId ?? req.tenant?.id;
  if (!tenantId) {
    throw new BadRequestException("Could not resolve a tenant for this request.");
  }
  return tenantId;
});

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.tenant) {
    throw new BadRequestException("Could not resolve a tenant for this request.");
  }
  return req.tenant;
});
