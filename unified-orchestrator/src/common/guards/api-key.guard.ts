import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

/**
 * Admin API-key guard — fail-closed.
 * Reads `x-api-key` header and compares to ADMIN_API_KEY env var.
 * If ADMIN_API_KEY is not configured the guard throws 500 (misconfiguration),
 * never allowing requests through.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>("ADMIN_API_KEY");

    if (!expected) {
      throw new InternalServerErrorException(
        "Server misconfiguration: ADMIN_API_KEY is not set",
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header("x-api-key");

    if (!provided || provided !== expected) {
      throw new UnauthorizedException("Invalid or missing admin API key");
    }

    return true;
  }
}
