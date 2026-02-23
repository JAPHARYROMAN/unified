/**
 * v1.1 QA — E2E on public testnet (Amoy). Requires testnet-deployment.json (run deploy-testnet, wait 24h, run execute-testnet-timelock first).
 * Runs orchestrator in staging config (real RPC, real chain sender), simulates M-Pesa outbound/inbound CONFIRMED and drives proof calls.
 * Produces report: deployment addresses, tx hashes, timestamps, final states.
 *
 * Single command: npm run e2e:testnet
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

const ROOT = path.resolve(__dirname, "..");
const ORCHESTRATOR_DIR = path.join(ROOT, "unified-orchestrator");
const DEPLOY_PATH = path.join(ROOT, "e2e", "testnet-deployment.json");
const REPORT_PATH = path.join(ROOT, "e2e", "testnet-e2e-report.json");

type Deployment = Record<string, string | number> & {
  RPC_URL?: string;
  timelockExecutedAt?: string;
};

const children: { kill: () => void }[] = [];
const report: {
  deploymentAddresses: Record<string, string>;
  txHashes: Record<string, string>;
  timestamps: Record<string, string>;
  finalState: { chain: { loanStatus: number }; db: { loanStatus: string; loanContract: string } };
  loanId?: string;
  loanContract?: string;
  error?: string;
} = { deploymentAddresses: {}, txHashes: {}, timestamps: {}, finalState: { chain: { loanStatus: 0 }, db: { loanStatus: "", loanContract: "" } } };

function killAll() {
  children.forEach((c) => {
    try { c.kill("SIGTERM"); } catch (_) {}
  });
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...env }, stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForHealth(baseUrl: string, maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Orchestrator health not ready");
}

function ts() {
  return new Date().toISOString();
}

async function main() {
  if (!fs.existsSync(DEPLOY_PATH)) {
    throw new Error(`Missing ${DEPLOY_PATH}. Run deploy-testnet.ts, wait 24h, run execute-testnet-timelock.ts.`);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL for the orchestrator.");
  }
  const deployment: Deployment = JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf-8"));
  if (!deployment.timelockExecutedAt) {
    throw new Error("Timelock not executed. Run execute-testnet-timelock.ts first.");
  }

  const rpcUrl = deployment.RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL or AMOY_RPC_URL required.");
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.E2E_DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY or E2E_DEPLOYER_PRIVATE_KEY required.");
  const borrowerKey = process.env.E2E_BORROWER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const adminKey = process.env.E2E_ADMIN_API_KEY || "e2e-admin-api-key-min-16-chars";
  const port = process.env.ORCHESTRATOR_PORT || "3001";
  const baseUrl = `http://localhost:${port}`;

  report.deploymentAddresses = {
    LOAN_FACTORY_ADDRESS: String(deployment.LOAN_FACTORY_ADDRESS),
    POOL_ADDRESS: String(deployment.POOL_ADDRESS),
    USDC_ADDRESS: String(deployment.USDC_ADDRESS),
    COLLATERAL_TOKEN_ADDRESS: String(deployment.COLLATERAL_TOKEN_ADDRESS),
    COLLATERAL_VAULT_ADDRESS: String(deployment.COLLATERAL_VAULT_ADDRESS),
    SETTLEMENT_AGENT_ADDRESS: String(deployment.SETTLEMENT_AGENT_ADDRESS ?? deployment.DEPLOYER_ADDRESS),
  };
  report.timestamps.runStarted = ts();

  console.log("\n=== 1. Start orchestrator (staging: real RPC, real chain sender) ===");
  await run("npx", ["prisma", "migrate", "deploy"], ORCHESTRATOR_DIR);
  const orchEnv = {
    ...process.env,
    PORT: port,
    NODE_ENV: "staging",
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_API_KEY: adminKey,
    CORS_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
    E2E_MODE: "1",
    CHAIN_ACTION_RPC_URL: rpcUrl,
    CHAIN_ACTION_FACTORY_ADDRESS: deployment.LOAN_FACTORY_ADDRESS,
    CHAIN_ACTION_SIGNER_PRIVATE_KEY: deployerKey,
  };
  const orch = spawn("npm", ["run", "start"], { cwd: ORCHESTRATOR_DIR, env: orchEnv, stdio: "pipe" });
  children.push(orch);
  await waitForHealth(baseUrl);
  console.log("   Orchestrator ready at", baseUrl);

  const headers = { "Content-Type": "application/json", "x-api-key": adminKey };
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(deployerKey, provider);
  const borrower = new ethers.Wallet(borrowerKey, provider);

  console.log("\n=== 2. Partner onboard → active ===");
  const registerRes = await fetch(`${baseUrl}/partners/register`, {
    method: "POST", headers,
    body: JSON.stringify({
      legalName: "Testnet QA Partner",
      jurisdictionCode: 840,
      registrationNumber: "QA-REG-001",
      complianceEmail: "qa@test.test",
      treasuryWallet: deployment.DEPLOYER_ADDRESS,
    }),
  });
  if (!registerRes.ok) throw new Error(`Register failed: ${await registerRes.text()}`);
  const { partnerId } = await registerRes.json();
  await fetch(`${baseUrl}/partners/${partnerId}/submit`, { method: "POST", headers, body: JSON.stringify({ payload: {} }) });
  await fetch(`${baseUrl}/admin/partners/${partnerId}/start-review`, { method: "POST", headers });
  await fetch(`${baseUrl}/admin/partners/${partnerId}/approve`, { method: "POST", headers });
  const actRes = await fetch(`${baseUrl}/admin/partners/${partnerId}/activate`, {
    method: "POST", headers,
    body: JSON.stringify({ poolContract: deployment.POOL_ADDRESS, chainId: deployment.CHAIN_ID }),
  });
  if (!actRes.ok) throw new Error(`Activate failed: ${await actRes.text()}`);
  const { apiKey } = (await actRes.json());
  const partnerApiKey = apiKey.key;
  report.timestamps.partnerActive = ts();

  console.log("\n=== 3. Originate loan via orchestrator ===");
  const principal = "500000000";
  const createRes = await fetch(`${baseUrl}/loans`, {
    method: "POST",
    headers: { ...headers, "x-api-key": partnerApiKey },
    body: JSON.stringify({
      borrowerWallet: deployment.BORROWER_ADDRESS,
      principalUsdc: principal,
      collateralToken: deployment.COLLATERAL_TOKEN_ADDRESS,
      collateralAmount: ethers.parseEther("5").toString(),
      durationSeconds: 30 * 24 * 3600,
      interestRateBps: 500,
    }),
  });
  if (!createRes.ok) throw new Error(`Create loan failed: ${await createRes.text()}`);
  const { loanId } = await createRes.json();

  console.log("\n=== 4. Wait for worker → FUNDING + loanContract ===");
  let loanContract: string | null = null;
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${baseUrl}/loans/${loanId}`, { headers: { "x-api-key": partnerApiKey } });
    const loan = await r.json();
    if (loan.status === "FUNDING" && loan.loanContract) {
      loanContract = loan.loanContract;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!loanContract) throw new Error("Loan did not reach FUNDING with loanContract");

  const weth = new ethers.Contract(deployment.COLLATERAL_TOKEN_ADDRESS as string, ["function approve(address,uint256) returns (bool)"], borrower);
  const vaultAddr = deployment.COLLATERAL_VAULT_ADDRESS as string;
  await weth.approve(vaultAddr, ethers.MaxUint256);
  const loanBorrower = new ethers.Contract(loanContract, ["function lockCollateral()"], borrower);
  const txLock = await loanBorrower.lockCollateral();
  const recLock = await txLock.wait();
  report.txHashes.lockCollateral = recLock!.hash;
  report.timestamps.lockCollateral = ts();

  console.log("\n=== 6. Allocate to loan ===");
  const pool = new ethers.Contract(deployment.POOL_ADDRESS as string, ["function allocateToLoan(address,uint256)"], wallet);
  const txAlloc = await pool.allocateToLoan(loanContract, principal);
  const recAlloc = await txAlloc.wait();
  report.txHashes.allocateToLoan = recAlloc!.hash;

  console.log("\n=== 7. Simulate M-Pesa outbound CONFIRMED → record proof → activate ===");
  const settlementAgent = new ethers.Wallet(deployerKey, provider);
  const loanAgent = new ethers.Contract(loanContract, ["function recordFiatDisbursement(bytes32)", "function activateAndDisburse()"], settlementAgent);
  const loanBorrowerAct = new ethers.Contract(loanContract, ["function activateAndDisburse()", "function status() view returns (uint8)", "function totalDebt() view returns (uint256)", "function repay(uint256)", "function close()"], borrower);
  const disbursementRef = ethers.keccak256(ethers.toUtf8Bytes("mpesa-outbound-CONFIRMED-" + loanId));
  const txProof = await loanAgent.recordFiatDisbursement(disbursementRef);
  const recProof = await txProof.wait();
  report.txHashes.recordFiatDisbursement = recProof!.hash;
  report.timestamps.mpesaOutboundConfirmed = ts();
  const txAct = await loanBorrowerAct.activateAndDisburse();
  const recAct = await txAct.wait();
  report.txHashes.activateAndDisburse = recAct!.hash;
  report.timestamps.activateAndDisburse = ts();

  console.log("\n=== 8. Repay ===");
  const debt = await loanBorrowerAct.totalDebt();
  const usdcBorrower = new ethers.Contract(deployment.USDC_ADDRESS as string, ["function approve(address,uint256) returns (bool)"], borrower);
  const usdcWallet = new ethers.Contract(deployment.USDC_ADDRESS as string, ["function mint(address,uint256)"], wallet);
  await usdcWallet.mint(borrower.address, debt);
  await usdcBorrower.approve(loanContract, debt);
  const txRepay = await loanBorrowerAct.repay(debt);
  const recRepay = await txRepay.wait();
  report.txHashes.repay = recRepay!.hash;
  report.timestamps.repay = ts();

  console.log("\n=== 9. Simulate M-Pesa inbound CONFIRMED → record repay proof ===");
  const repayRef = ethers.keccak256(ethers.toUtf8Bytes("mpesa-inbound-CONFIRMED-" + loanId));
  const loanAgentRep = new ethers.Contract(loanContract, ["function recordFiatRepayment(bytes32)"], settlementAgent);
  const txRepProof = await loanAgentRep.recordFiatRepayment(repayRef);
  const recRepProof = await txRepProof.wait();
  report.txHashes.recordFiatRepayment = recRepProof!.hash;
  report.timestamps.mpesaInboundConfirmed = ts();

  console.log("\n=== 10. Close and verify final state ===");
  const txClose = await loanBorrowerAct.close();
  const recClose = await txClose.wait();
  report.txHashes.close = recClose!.hash;
  report.timestamps.close = ts();

  const loanView = new ethers.Contract(loanContract, ["function status() view returns (uint8)"], provider);
  const chainStatus = await loanView.status();
  report.finalState.chain.loanStatus = Number(chainStatus);
  const loanRes = await fetch(`${baseUrl}/loans/${loanId}`, { headers: { "x-api-key": partnerApiKey } });
  const loanRow = await loanRes.json();
  report.finalState.db.loanStatus = loanRow.status;
  report.finalState.db.loanContract = loanRow.loanContract || loanContract;
  report.loanId = loanId;
  report.loanContract = loanContract;
  report.timestamps.runFinished = ts();

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("\n=== Report written to", REPORT_PATH);
  console.log("   Deployment addresses:", Object.keys(report.deploymentAddresses).length);
  console.log("   Tx hashes:", Object.keys(report.txHashes).length);
  console.log("   Final chain status:", report.finalState.chain.loanStatus, "(5=CLOSED)");
  console.log("   Final DB status:", report.finalState.db.loanStatus);
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    report.error = err instanceof Error ? err.message : String(err);
    report.timestamps.runFinished = ts();
    try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch (_) {}
    console.error(err);
    killAll();
    process.exit(1);
  });
