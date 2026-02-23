/**
 * E2E smoke test: deploy (real scripts) → orchestrator (test mode) → partner onboarding →
 * create POOL loan → worker creates on-chain → lockCollateral → [fiat proof if enabled] →
 * activateAndDisburse → repay → close. Validates on-chain status progression, DB/chain alignment, role wiring.
 *
 * Requires: DATABASE_URL (PostgreSQL). Run: npm run e2e
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { assertDeployRoles, assertPoolLoanRole } from "./assertions";

export type E2EPhase = "DEPLOY" | "BACKEND" | "CHAIN_ACTIONS" | "ROLE_WIRING";

export function formatE2EFailure(phase: E2EPhase, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `[E2E FAILED @ ${phase}] ${msg}`;
}

const ROOT = path.resolve(__dirname, "..");
const ORCHESTRATOR_DIR = path.join(ROOT, "unified-orchestrator");
const DEPLOYER_KEY =
  process.env.E2E_DEPLOYER_PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RPC = "http://127.0.0.1:8545";
const ORCHESTRATOR_PORT = process.env.ORCHESTRATOR_PORT || "3001";
const BASE_URL = `http://localhost:${ORCHESTRATOR_PORT}`;
const ADMIN_KEY = process.env.E2E_ADMIN_API_KEY || "e2e-admin-api-key-min-16-chars";

const children: { kill: () => void }[] = [];

function killAll() {
  children.forEach((c) => {
    try {
      c.kill("SIGTERM");
    } catch (_) {}
  });
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...env }, stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForRpc(maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC);
      await provider.getBlockNumber();
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("RPC not ready");
}

async function waitForHealth(maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Orchestrator health not ready");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL for the orchestrator (e.g. postgresql://user:pass@localhost:5432/unified_e2e)");
  }

  let deployment: Record<string, string | number>;

  console.log("\n=== 1. Start Hardhat node ===");
  const node = spawn("npx", ["hardhat", "node"], { cwd: ROOT, stdio: "pipe" });
  children.push(node);
  await waitForRpc();
  console.log("   RPC ready at", RPC);

  try {
    console.log("\n=== 2. Deploy (real deploy + E2E pool/collateral) ===");
    await run("npx", ["hardhat", "run", "scripts/deploy-e2e.ts", "--network", "localhost"], ROOT);
    deployment = JSON.parse(
      fs.readFileSync(path.join(ROOT, "e2e", "deployment.json"), "utf-8"),
    );
  } catch (err) {
    throw new Error(formatE2EFailure("DEPLOY", err));
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  try {
    console.log("\n=== 3. Role assertions (deploy) ===");
    await assertDeployRoles(provider, deployment);
    console.log("   ✓ FeeManager/CollateralVault/Pool registrar grants OK");
  } catch (err) {
    throw new Error(formatE2EFailure("ROLE_WIRING", err));
  }

  let partnerId: string;
  let partnerApiKey: string;
  let loanId: string;
  let loanContract: string;

  try {
    console.log("\n=== 4. DB migrations and start orchestrator (test mode) ===");
    await run("npx", ["prisma", "migrate", "deploy"], ORCHESTRATOR_DIR);
    const orchestratorEnv = {
      ...process.env,
      PORT: ORCHESTRATOR_PORT,
      DATABASE_URL: process.env.DATABASE_URL,
      ADMIN_API_KEY: ADMIN_KEY,
      CORS_ORIGINS: `http://localhost:${ORCHESTRATOR_PORT},http://127.0.0.1:${ORCHESTRATOR_PORT}`,
      E2E_MODE: "1",
      CHAIN_ACTION_RPC_URL: RPC,
      CHAIN_ACTION_FACTORY_ADDRESS: deployment.LOAN_FACTORY_ADDRESS,
      CHAIN_ACTION_SIGNER_PRIVATE_KEY: DEPLOYER_KEY,
    };
    const orch = spawn("npm", ["run", "start"], {
      cwd: ORCHESTRATOR_DIR,
      env: orchestratorEnv,
      stdio: "pipe",
    });
    children.push(orch);
    await waitForHealth();
    console.log("   Orchestrator ready at", BASE_URL);

    const headers = { "Content-Type": "application/json", "x-api-key": ADMIN_KEY };

    console.log("\n=== 5. Partner onboarding ===");
    const registerRes = await fetch(`${BASE_URL}/partners/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        legalName: "E2E Partner LLC",
        jurisdictionCode: 840,
        registrationNumber: "E2E-REG-001",
        complianceEmail: "compliance@e2e.test",
        treasuryWallet: deployment.DEPLOYER_ADDRESS,
      }),
    });
    if (!registerRes.ok) throw new Error(`Register failed: ${await registerRes.text()}`);
    const reg = await registerRes.json();
    partnerId = reg.partnerId;
    console.log("   Registered partner:", partnerId);

    await fetch(`${BASE_URL}/partners/${partnerId}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload: { kyc: "stub" } }),
    });
    if (!(await fetch(`${BASE_URL}/admin/partners/${partnerId}/start-review`, { method: "POST", headers })).ok)
      throw new Error("Start review failed");
    if (!(await fetch(`${BASE_URL}/admin/partners/${partnerId}/approve`, { method: "POST", headers })).ok)
      throw new Error("Approve failed");

    const activateRes = await fetch(`${BASE_URL}/admin/partners/${partnerId}/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        poolContract: deployment.POOL_ADDRESS,
        chainId: deployment.CHAIN_ID,
      }),
    });
    if (!activateRes.ok) throw new Error(`Activate failed: ${await activateRes.text()}`);
    const act = await activateRes.json();
    partnerApiKey = act.apiKey.key;
    console.log("   Partner activated, API key issued");

    console.log("\n=== 6. Create loan (POOL) via orchestrator ===");
    const principal = "500000000"; // 500 USDC (6 decimals)
    const collateralAmount = ethers.parseEther("5").toString();
    const createRes = await fetch(`${BASE_URL}/loans`, {
      method: "POST",
      headers: { ...headers, "x-api-key": partnerApiKey },
      body: JSON.stringify({
        borrowerWallet: deployment.BORROWER_ADDRESS,
        principalUsdc: principal,
        collateralToken: deployment.COLLATERAL_TOKEN_ADDRESS,
        collateralAmount,
        durationSeconds: 30 * 24 * 3600,
        interestRateBps: 500,
      }),
    });
    if (!createRes.ok) throw new Error(`Create loan failed: ${await createRes.text()}`);
    const cr = await createRes.json();
    loanId = cr.loanId;
    console.log("   Loan created:", loanId);

    console.log("\n=== 7. Wait for worker → FUNDING + loanContract ===");
    let contract: string | null = null;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${BASE_URL}/loans/${loanId}`, {
        headers: { "x-api-key": partnerApiKey },
      });
      const loan = await r.json();
      if (loan.status === "FUNDING" && loan.loanContract) {
        contract = loan.loanContract;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!contract) throw new Error("Loan did not transition to FUNDING with loanContract");
    loanContract = contract;

    try {
      await assertPoolLoanRole(provider, deployment.POOL_ADDRESS, loanContract);
      console.log("   ✓ Pool LOAN_ROLE granted to loan");
    } catch (err) {
      throw new Error(formatE2EFailure("ROLE_WIRING", err));
    }
  } catch (err) {
    throw new Error(formatE2EFailure("BACKEND", err));
  }

  try {
    console.log("\n=== 8. On-chain: lockCollateral → allocate → [fiat proof if enabled] → activateAndDisburse ===");
    const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);
    const borrower = new ethers.Wallet(
      process.env.E2E_BORROWER_PRIVATE_KEY ||
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      provider,
    );

    const usdc = new ethers.Contract(
      deployment.USDC_ADDRESS as string,
      ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
      borrower,
    );
    const weth = new ethers.Contract(
      deployment.COLLATERAL_TOKEN_ADDRESS as string,
      ["function approve(address,uint256) returns (bool)"],
      borrower,
    );
    const vaultAddr = deployment.COLLATERAL_VAULT_ADDRESS as string;
    const loan = new ethers.Contract(
      loanContract,
      [
        "function lockCollateral()",
        "function activateAndDisburse()",
        "function repay(uint256)",
        "function close()",
        "function status() view returns (uint8)",
        "function totalDebt() view returns (uint256)",
        "function requireFiatProofBeforeActivate() view returns (bool)",
        "function settlementAgent() view returns (address)",
        "function recordFiatDisbursement(bytes32)",
      ],
      borrower,
    );

    await weth.approve(vaultAddr, ethers.MaxUint256);
    await loan.lockCollateral();

    const pool = new ethers.Contract(
      deployment.POOL_ADDRESS as string,
      ["function allocateToLoan(address,uint256)"],
      wallet,
    );
    await pool.allocateToLoan(loanContract, principal);

    const requireFiat = await loan.requireFiatProofBeforeActivate();
    if (requireFiat) {
      const agentAddr = await loan.settlementAgent();
      if (agentAddr && agentAddr !== ethers.ZeroAddress) {
        const agentSigner = agentAddr.toLowerCase() === (await wallet.getAddress()).toLowerCase()
          ? wallet
          : new ethers.Wallet(process.env.E2E_SETTLEMENT_AGENT_PRIVATE_KEY || DEPLOYER_KEY, provider);
        const loanAsAgent = new ethers.Contract(loanContract, ["function recordFiatDisbursement(bytes32)"], agentSigner);
        await loanAsAgent.recordFiatDisbursement(ethers.zeroPadValue("0x01", 32));
        console.log("   ✓ Fiat disbursement proof recorded");
      } else {
        throw new Error("Fiat proof required but settlementAgent not set on loan");
      }
    }

    await loan.activateAndDisburse();
    let status = await loan.status();
    if (Number(status) !== 2) throw new Error(`Expected chain status ACTIVE (2) after activateAndDisburse, got ${status}`);
    console.log("   ✓ Loan active (chain status ACTIVE)");

    console.log("\n=== 9. Repay and close ===");
    const debt = await loan.totalDebt();
    const usdcContract = new ethers.Contract(
      deployment.USDC_ADDRESS as string,
      ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"],
      wallet,
    );
    await usdcContract.mint(borrower.address, debt);
    await usdc.approve(loanContract, debt);
    await loan.repay(debt);
    status = await loan.status();
    if (Number(status) !== 3) throw new Error(`Expected chain status REPAID (3) after repay, got ${status}`);
    console.log("   ✓ Repaid (chain status REPAID)");

    await loan.close();
    status = await loan.status();
    if (Number(status) !== 5) throw new Error(`Expected chain status CLOSED (5), got ${status}`);
    console.log("   ✓ Closed (chain status CLOSED)");

    console.log("\n=== 10. Assert DB vs chain ===");
    const loanRes = await fetch(`${BASE_URL}/loans/${loanId}`, {
      headers: { "x-api-key": partnerApiKey },
    });
    const loanRow = await loanRes.json();
    if (loanRow.status !== "FUNDING" || loanRow.loanContract !== loanContract)
      throw new Error(`DB loan: expected FUNDING and loanContract ${loanContract}, got ${loanRow.status} / ${loanRow.loanContract}`);
    console.log("   ✓ DB status FUNDING with correct loanContract (orchestrator syncs up to FUNDING only)");
  } catch (err) {
    throw new Error(formatE2EFailure("CHAIN_ACTIONS", err));
  }

  console.log("\n=== E2E smoke PASSED ===");
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    killAll();
    process.exit(1);
  });
