import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger("HTTP");

  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl } = req;
    const requestId =
      (req.headers["x-request-id"] as string | undefined) ?? randomUUID();

    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);

    const start = Date.now();

    res.on("finish", () => {
      const duration = Date.now() - start;
      const { statusCode } = res;
      this.logger.log(
        `${method} ${originalUrl} ${statusCode} — ${duration}ms [${requestId}]`,
      );
    });

    next();
  }
}
