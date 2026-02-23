import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ChainActionWorker } from "./modules/chain-action/chain-action.worker";
import { createEthersChainSender } from "./modules/chain-action/ethers-chain-sender";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 3000);

  // ─── Global pipes ───
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // ─── Global filters ───
  app.useGlobalFilters(new AllExceptionsFilter());

  // ─── CORS — env-configured allowlist, restrictive by default ───
  const rawOrigins = config.get<string>("CORS_ORIGINS", "");
  const allowedOrigins = rawOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (server-to-server, curl in dev)
      // only when not in production.
      if (!origin) {
        const isProd = config.get<string>("NODE_ENV") === "production";
        return callback(isProd ? new Error("Origin required") : null, !isProd);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS: origin ${origin} not allowed`), false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "x-admin-subject"],
    credentials: false,
  });

  await app.listen(port);
  Logger.log(
    `unified-orchestrator listening on http://localhost:${port}`,
    "Bootstrap",
  );

  // ─── Chain action worker ──────────────────────────────────────────────────
  // Always wire the real sender in non-test environments.
  // env.validation.ts enforces that all three vars are present when
  // NODE_ENV !== 'test', so missing values crash validateConfig() before
  // we even reach this point (no fail-open).
  const nodeEnv = config.get<string>("NODE_ENV");
  if (nodeEnv !== "test") {
    const rpcUrl = config.get<string>("CHAIN_ACTION_RPC_URL")!;
    const factoryAddr = config.get<string>("CHAIN_ACTION_FACTORY_ADDRESS")!;
    const signerKey = config.get<string>("CHAIN_ACTION_SIGNER_PRIVATE_KEY")!;

    const sender = createEthersChainSender({
      rpcUrl,
      factoryAddress: factoryAddr,
      privateKey: signerKey,
    });

    // Hard fail if the RPC endpoint is unreachable — better to crash at
    // startup than to silently accept requests that will never be executed.
    const healthy = await sender.isHealthy();
    if (!healthy) {
      throw new Error(
        `Chain RPC unreachable at startup: ${rpcUrl}. ` +
          "Check CHAIN_ACTION_RPC_URL and network connectivity.",
      );
    }

    const worker = app.get(ChainActionWorker);
    worker.setSender(sender);
    await worker.startPolling(2_000, 5_000);
    Logger.log("Chain action worker started", "Bootstrap");
  }
}

bootstrap();
