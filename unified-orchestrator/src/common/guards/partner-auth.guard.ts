import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { PartnerApiKeyService } from "../../modules/partner/partner-api-key.service";

/**
 * Guard that authenticates partner API keys.
 * Reads x-api-key header, validates against stored hashes,
 * and attaches partnerId to the request object.
 */
@Injectable()
export class PartnerAuthGuard implements CanActivate {
  constructor(private readonly apiKeyService: PartnerApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const apiKey = req.header("x-api-key");

    if (!apiKey) {
      throw new UnauthorizedException("Missing x-api-key header");
    }

    const partnerId = await this.apiKeyService.validate(apiKey);
    if (!partnerId) {
      throw new UnauthorizedException("Invalid or revoked API key");
    }

    // Attach partner context to request
    (req as any).partnerId = partnerId;
    return true;
  }
}
