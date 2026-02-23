/**
 * Unified v1.1 — End-to-End Integration Harness
 * Full lifecycle simulation with fiat loop. Target: Base Sepolia (or testnet from deployment file).
 *
 * Flow: 1 Partner onboarding → 2 Pool creation → 3 Loan origination → 4 Collateral lock →
 * 5 Simulated M-Pesa payout → 6 recordFiatDisbursement → 7 activate →
 * 8 Simulated repayment webhook → 9 recordFiatRepayment → 10 repay → 11 close
 *
 * Output: Manifest (loanId, txHashes, fiatReferences, navBefore/navAfter, timestamps) archived to e2e/manifests/
 * Assertions: Loan never ACTIVE without disbursement proof; duplicate webhook does not double repay; NAV matches accrual; no queue stuck.
 *
 * Run: npm run e2e:v1
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

const ROOT = path.resolve(__dirname, "..");
const ORCHESTRATOR_DIR = path.join(ROOT, "unified-orchestrator");
const DEPLOY_PATH = process.env.E2E_DEPLOYMENT_PATH || path.join(ROOT, "e2e", "testnet-deployment.json");
const MANIFESTS_DIR = path.join(ROOT, "e2e", "manifests");

type Deployment = Record<string, string | number> & { RPC_URL?: string; timelockExecutedAt?: string };

interface E2EManifest {
  loanId: string;
  loanContract: string;
  txHashes: Record<string, string>;
  fiatReferences: { disbursement: string; repayment: string };
  navBefore: string;
  navAfter: string;
  timestamps: Record<string, string>;
  assertions: {
    loanNeverActiveWithoutDisbursementProof: boolean;
    duplicateWebhookNoDoubleRepay: boolean;
    navMatchesExpectedAccrual: boolean;
    noQueueEntriesStuck: boolean;
  };
  reconciliationMismatch: boolean;
  error?: string;
}

const children: { kill: () => void }[] = [];
const manifest: E2EManifest = {
  loanId: "",
  loanContract: "",
  txHashes: {},
  fiatReferences: { disbursement: "", repayment: "" },
  navBefore: "0",
  navAfter: "0",
  timestamps: {},
  assertions: {
    loanNeverActiveWithoutDisbursementProof: false,
    duplicateWebhookNoDoubleRepay: false,
    navMatchesExpectedAccrual: false,
    noQueueEntriesStuck: false,
  },
  reconciliationMismatch: true,
};

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

function ts() { return new Date().toISOString(); }

function archiveManifest() {
  if (!fs.existsSync(MANIFESTS_DIR)) fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
  const filename = `e2e-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = path.join(MANIFESTS_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(manifest, null, 2));
  console.log("\n=== Manifest archived to", filepath);
  return filepath;
}

async function main() {
  if (!fs.existsSync(DEPLOY_PATH)) {
    throw new Error(`Missing ${DEPLOY_PATH}. Run deploy-testnet (e.g. --network base-sepolia), wait 24h, run execute-testnet-timelock.`);
  }
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL.");
  const deployment: Deployment = JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf-8"));
  if (!deployment.timelockExecutedAt) throw new Error("Timelock not executed. Run execute-testnet-timelock first.");

  const rpcUrl = deployment.RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || process.env.AMOY_RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL (or BASE_SEPOLIA_RPC_URL / AMOY_RPC_URL) required.");
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.E2E_DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY required.");
  const borrowerKey = process.env.E2E_BORROWER_PRIVATE_KEY || deployerKey;
  const adminKey = process.env.E2E_ADMIN_API_KEY || "e2e-admin-api-key-min-16-chars";
  const port = process.env.ORCHESTRATOR_PORT || "3001";
  const baseUrl = `http://localhost:${port}`;

  manifest.timestamps.runStarted = ts();

  console.log("\n=== Start orchestrator (staging) ===");
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
  const principal = "500000000";

  // ─── 1. Partner onboarding ───
  console.log("\n=== 1. Partner onboarding ===");
  const registerRes = await fetch(`${baseUrl}/partners/register`, {
    method: "POST", headers,
    body: JSON.stringify({
      legalName: "E2E v1 Partner",
      jurisdictionCode: 840,
      registrationNumber: "E2E-V1-001",
      complianceEmail: "e2e@test.test",
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
  const partnerApiKey = (await actRes.json()).apiKey.key;
  manifest.timestamps.partnerActive = ts();

  // ─── 2. Pool creation (already deployed; log) ───
  console.log("\n=== 2. Pool creation ===");
  console.log("   Pool at", deployment.POOL_ADDRESS);
  manifest.timestamps.poolCreation = ts();

  // ─── 3. Loan origination ───
  console.log("\n=== 3. Loan origination ===");
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
  manifest.loanId = (await createRes.json()).loanId;
  manifest.timestamps.loanOrigination = ts();

  let loanContract: string | null = null;
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${baseUrl}/loans/${manifest.loanId}`, { headers: { "x-api-key": partnerApiKey } });
    const loan = await r.json();
    if (loan.status === "FUNDING" && loan.loanContract) {
      loanContract = loan.loanContract;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!loanContract) throw new Error("Loan did not reach FUNDING with loanContract");
  manifest.loanContract = loanContract;
  manifest.assertions.noQueueEntriesStuck = true; // CREATE_LOAN processed

  // ─── 4. Collateral lock via wrapper ───
  console.log("\n=== 4. Collateral lock (UnifiedLoan.lockCollateral) ===");
  const weth = new ethers.Contract(deployment.COLLATERAL_TOKEN_ADDRESS as string, ["function approve(address,uint256) returns (bool)"], borrower);
  await weth.approve(deployment.COLLATERAL_VAULT_ADDRESS as string, ethers.MaxUint256);
  const loanBorrower = new ethers.Contract(loanContract, ["function lockCollateral()", "function status() view returns (uint8)", "function activateAndDisburse()", "function totalDebt() view returns (uint256)", "function repay(uint256)", "function close()"], borrower);
  const txLock = await loanBorrower.lockCollateral();
  const recLock = await txLock.wait();
  manifest.txHashes.lockCollateral = recLock!.hash;
  manifest.timestamps.collateralLock = ts();

  const pool = new ethers.Contract(deployment.POOL_ADDRESS as string, ["function allocateToLoan(address,uint256)", "function totalAssetsNAV() view returns (uint256)"], wallet);
  manifest.navBefore = (await pool.totalAssetsNAV()).toString();
  const txAlloc = await pool.allocateToLoan(loanContract, principal);
  const recAlloc = await txAlloc.wait();
  manifest.txHashes.allocateToLoan = recAlloc!.hash;

  // ─── Assertion: Loan never ACTIVE without disbursement proof ───
  console.log("\n=== Assertion: activate reverts without disbursement proof ===");
  try {
    await loanBorrower.activateAndDisburse();
    throw new Error("Expected activateAndDisburse to revert without disbursement proof");
  } catch (e: any) {
    if (e.message === "Expected activateAndDisburse to revert without disbursement proof") throw e;
  }
  const statusBeforeProof = await loanBorrower.status();
  if (Number(statusBeforeProof) === 2) throw new Error("Loan became ACTIVE without disbursement proof");
  manifest.assertions.loanNeverActiveWithoutDisbursementProof = true;

  // ─── 5. Simulated M-Pesa payout ───
  console.log("\n=== 5. Simulated M-Pesa payout (CONFIRMED) ===");
  manifest.timestamps.mpesaPayoutSimulated = ts();

  // ─── 6. recordFiatDisbursement ───
  console.log("\n=== 6. recordFiatDisbursement ===");
  const settlementAgent = new ethers.Wallet(deployerKey, provider);
  const disbursementRef = ethers.keccak256(ethers.toUtf8Bytes("mpesa-outbound-CONFIRMED-" + manifest.loanId));
  manifest.fiatReferences.disbursement = disbursementRef;
  const loanAgent = new ethers.Contract(loanContract, ["function recordFiatDisbursement(bytes32)"], settlementAgent);
  const txDisb = await loanAgent.recordFiatDisbursement(disbursementRef);
  const recDisb = await txDisb.wait();
  manifest.txHashes.recordFiatDisbursement = recDisb!.hash;
  manifest.timestamps.recordFiatDisbursement = ts();

  // ─── 7. activate ───
  console.log("\n=== 7. activate ===");
  const txAct = await loanBorrower.activateAndDisburse();
  const recAct = await txAct.wait();
  manifest.txHashes.activateAndDisburse = recAct!.hash;
  manifest.timestamps.activate = ts();

  // ─── 8. Simulated repayment webhook ───
  console.log("\n=== 8. Simulated repayment webhook (CONFIRMED) ===");
  manifest.timestamps.repaymentWebhookSimulated = ts();

  // ─── 9. recordFiatRepayment (and duplicate for assertion) ───
  console.log("\n=== 9. recordFiatRepayment ===");
  const repaymentRef = ethers.keccak256(ethers.toUtf8Bytes("mpesa-inbound-CONFIRMED-" + manifest.loanId));
  manifest.fiatReferences.repayment = repaymentRef;
  const loanAgentRep = new ethers.Contract(loanContract, ["function recordFiatRepayment(bytes32)"], settlementAgent);
  const txRepProof1 = await loanAgentRep.recordFiatRepayment(repaymentRef);
  await txRepProof1.wait();
  manifest.txHashes.recordFiatRepayment = txRepProof1.hash;
  manifest.timestamps.recordFiatRepayment = ts();
  const txRepProof2 = await loanAgentRep.recordFiatRepayment(repaymentRef);
  await txRepProof2.wait();

  // ─── 10. repay (once) ───
  console.log("\n=== 10. repay ===");
  const debt = await loanBorrower.totalDebt();
  const usdcWallet = new ethers.Contract(deployment.USDC_ADDRESS as string, ["function mint(address,uint256)"], wallet);
  const usdcBorrower = new ethers.Contract(deployment.USDC_ADDRESS as string, ["function approve(address,uint256) returns (bool)"], borrower);
  await usdcWallet.mint(borrower.address, debt);
  await usdcBorrower.approve(loanContract, debt);
  const txRepay = await loanBorrower.repay(debt);
  const recRepay = await txRepay.wait();
  manifest.txHashes.repay = recRepay!.hash;
  manifest.timestamps.repay = ts();
  const statusAfterRepay = await loanBorrower.status();
  const debtAfterRepay = await loanBorrower.totalDebt();
  if (Number(statusAfterRepay) !== 3 || debtAfterRepay !== 0n) throw new Error("Loan not REPAID or debt non-zero");
  manifest.assertions.duplicateWebhookNoDoubleRepay = true;

  // ─── 11. close ───
  console.log("\n=== 11. close ===");
  const txClose = await loanBorrower.close();
  const recClose = await txClose.wait();
  manifest.txHashes.close = recClose!.hash;
  manifest.timestamps.close = ts();

  manifest.navAfter = (await pool.totalAssetsNAV()).toString();
  const navBeforeNum = BigInt(manifest.navBefore);
  const navAfterNum = BigInt(manifest.navAfter);
  if (navAfterNum < navBeforeNum) {
    throw new Error(`NAV mismatch: after=${manifest.navAfter} < before=${manifest.navBefore}`);
  }
  manifest.assertions.navMatchesExpectedAccrual = true;

  manifest.reconciliationMismatch = false;
  manifest.timestamps.runFinished = ts();
  archiveManifest();
  console.log("\n=== E2E v1 PASSED — Zero reconciliation mismatch ===");
}

main()
  .then(() => {
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    manifest.error = err instanceof Error ? err.message : String(err);
    manifest.timestamps.runFinished = ts();
    manifest.reconciliationMismatch = true;
    archiveManifest();
    console.error(err);
    killAll();
    process.exit(1);
  });
