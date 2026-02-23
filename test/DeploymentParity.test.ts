/**
 * DeploymentParity.test.ts
 *
 * Validates that scripts/deploy.ts produces a correctly wired system.
 * Uses the exported `main()` from the deploy script — NOT the test fixtures —
 * so it catches any divergence between "passes tests" and "works on-chain".
 *
 * Sections:
 *   A. Role grants
 *   B. Contract pointer wiring
 *   C. Timelock coverage (every timelocked setter reverts without prior schedule)
 *   D. E2E createLoan flow (vault LOAN_ROLE + feeManager LOAN_ROLE + fee collection)
 *   E. POOL loan LOAN_ROLE wiring (factory auto-grants role on pool)
 *   F. Report written to docs/deployment-parity-report.md
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { main as deployMain } from "../scripts/deploy";

// ─── Timelock helpers (mirrors test fixtures) ─────────────────────────────────

const TIMELOCK_DELAY = 24 * 3600;

function computeTimelockId(iface: any, funcName: string, args: any[]): string {
  const fragment = iface.getFunction(funcName)!;
  const paramTypes = fragment.inputs.map((p: any) => p.type);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes4", ...paramTypes],
    [fragment.selector, ...args],
  );
  return ethers.keccak256(encoded);
}

async function timelockExec(contract: any, funcName: string, args: any[]) {
  const id = computeTimelockId(contract.interface, funcName, args);
  await contract.scheduleTimelock(id);
  await time.increase(TIMELOCK_DELAY);
  await contract[funcName](...args);
}

// ─── Shared state (populated by before()) ────────────────────────────────────

let deployerAddr: string;
let usdcAddr: string;
let treasuryAddr: string;
let feeManagerAddr: string;
let riskRegistryAddr: string;
let collateralVaultAddr: string;
let loanImplAddr: string;
let factoryAddr: string;

let factory: any;
let feeManager: any;
let vault: any;
let treasury: any;
let riskRegistry: any;
let usdc: any;

// Track report rows
interface ReportRow {
  section: string;
  check: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const report: ReportRow[] = [];

function row(section: string, check: string, passed: boolean, detail?: string) {
  report.push({ section, check, status: passed ? "PASS" : "FAIL", detail });
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Deployment Parity", function () {
  this.timeout(120_000);

  // ── Setup: deploy via actual deploy script ─────────────────────────────────

  before(async function () {
    const [deployer] = await ethers.getSigners();
    deployerAddr = deployer.address;

    // 1. Deploy a MockERC20 to serve as USDC (deploy script needs USDC_ADDRESS)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    usdcAddr = await usdc.getAddress();

    // 2. Set env vars consumed by deploy script
    process.env.USDC_ADDRESS = usdcAddr;
    const outFile = path.join(os.tmpdir(), `unified-deploy-${Date.now()}.json`);
    process.env.E2E_DEPLOY_OUTPUT = outFile;

    // 3. Run the actual deploy script
    await deployMain();

    // 4. Read addresses from JSON output
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
    treasuryAddr = out.TREASURY_ADDRESS;
    feeManagerAddr = out.FEE_MANAGER_ADDRESS;
    riskRegistryAddr = out.RISK_REGISTRY_ADDRESS;
    collateralVaultAddr = out.COLLATERAL_VAULT_ADDRESS;
    loanImplAddr = out.LOAN_IMPLEMENTATION_ADDRESS;
    factoryAddr = out.LOAN_FACTORY_ADDRESS;
    fs.unlinkSync(outFile);

    // 5. Attach contract instances
    factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr);
    feeManager = await ethers.getContractAt(
      "UnifiedFeeManager",
      feeManagerAddr,
    );
    vault = await ethers.getContractAt(
      "UnifiedCollateralVault",
      collateralVaultAddr,
    );
    treasury = await ethers.getContractAt("UnifiedTreasury", treasuryAddr);
    riskRegistry = await ethers.getContractAt(
      "UnifiedRiskRegistry",
      riskRegistryAddr,
    );
  });

  // ── A. Role grants ─────────────────────────────────────────────────────────

  describe("A. Role grants", function () {
    async function hasRole(contract: any, roleGetter: string, holder: string) {
      const role = await contract[roleGetter]();
      return contract.hasRole(role, holder);
    }

    it("A1: collateralVault — factory has LOAN_REGISTRAR_ROLE", async function () {
      const ok = await hasRole(vault, "LOAN_REGISTRAR_ROLE", factoryAddr);
      row("A", "vault: factory has LOAN_REGISTRAR_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A2: feeManager — factory has LOAN_REGISTRAR_ROLE", async function () {
      const ok = await hasRole(feeManager, "LOAN_REGISTRAR_ROLE", factoryAddr);
      row("A", "feeManager: factory has LOAN_REGISTRAR_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A3: collateralVault — deployer has DEFAULT_ADMIN_ROLE", async function () {
      const ok = await hasRole(vault, "DEFAULT_ADMIN_ROLE", deployerAddr);
      row("A", "vault: deployer has DEFAULT_ADMIN_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A4: feeManager — deployer has DEFAULT_ADMIN_ROLE", async function () {
      const ok = await hasRole(feeManager, "DEFAULT_ADMIN_ROLE", deployerAddr);
      row("A", "feeManager: deployer has DEFAULT_ADMIN_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A5: feeManager — deployer has FEE_ROLE", async function () {
      const ok = await hasRole(feeManager, "FEE_ROLE", deployerAddr);
      row("A", "feeManager: deployer has FEE_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A6: factory — deployer has DEFAULT_ADMIN_ROLE", async function () {
      const ok = await hasRole(factory, "DEFAULT_ADMIN_ROLE", deployerAddr);
      row("A", "factory: deployer has DEFAULT_ADMIN_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A7: factory — deployer has PAUSER_ROLE", async function () {
      const ok = await hasRole(factory, "PAUSER_ROLE", deployerAddr);
      row("A", "factory: deployer has PAUSER_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A8: treasury — deployer has DEFAULT_ADMIN_ROLE", async function () {
      const ok = await hasRole(treasury, "DEFAULT_ADMIN_ROLE", deployerAddr);
      row("A", "treasury: deployer has DEFAULT_ADMIN_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A9: treasury — deployer has WITHDRAWER_ROLE", async function () {
      const ok = await hasRole(treasury, "WITHDRAWER_ROLE", deployerAddr);
      row("A", "treasury: deployer has WITHDRAWER_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A10: riskRegistry — deployer has DEFAULT_ADMIN_ROLE", async function () {
      const ok = await hasRole(
        riskRegistry,
        "DEFAULT_ADMIN_ROLE",
        deployerAddr,
      );
      row("A", "riskRegistry: deployer has DEFAULT_ADMIN_ROLE", ok);
      expect(ok).to.be.true;
    });

    it("A11: riskRegistry — deployer has RISK_ORACLE_ROLE", async function () {
      const ok = await hasRole(riskRegistry, "RISK_ORACLE_ROLE", deployerAddr);
      row("A", "riskRegistry: deployer has RISK_ORACLE_ROLE", ok);
      expect(ok).to.be.true;
    });
  });

  // ── B. Contract pointer wiring ─────────────────────────────────────────────

  describe("B. Contract pointer wiring", function () {
    it("B1: factory.usdc == USDC_ADDRESS", async function () {
      const v = await factory.usdc();
      const ok = v.toLowerCase() === usdcAddr.toLowerCase();
      row("B", "factory.usdc == USDC_ADDRESS", ok, ok ? "" : `got ${v}`);
      expect(v.toLowerCase()).to.equal(usdcAddr.toLowerCase());
    });

    it("B2: factory.collateralVault == deployed vault", async function () {
      const v = await factory.collateralVault();
      const ok = v.toLowerCase() === collateralVaultAddr.toLowerCase();
      row("B", "factory.collateralVault == vault", ok, ok ? "" : `got ${v}`);
      expect(v.toLowerCase()).to.equal(collateralVaultAddr.toLowerCase());
    });

    it("B3: factory.feeManager == deployed feeManager", async function () {
      const v = await factory.feeManager();
      const ok = v.toLowerCase() === feeManagerAddr.toLowerCase();
      row("B", "factory.feeManager == feeManager", ok, ok ? "" : `got ${v}`);
      expect(v.toLowerCase()).to.equal(feeManagerAddr.toLowerCase());
    });

    it("B4: factory.treasury == deployed treasury", async function () {
      const v = await factory.treasury();
      const ok = v.toLowerCase() === treasuryAddr.toLowerCase();
      row("B", "factory.treasury == treasury", ok, ok ? "" : `got ${v}`);
      expect(v.toLowerCase()).to.equal(treasuryAddr.toLowerCase());
    });

    it("B5: factory.loanImplementation == deployed impl", async function () {
      const v = await factory.loanImplementation();
      const ok = v.toLowerCase() === loanImplAddr.toLowerCase();
      row(
        "B",
        "factory.loanImplementation == loanImpl",
        ok,
        ok ? "" : `got ${v}`,
      );
      expect(v.toLowerCase()).to.equal(loanImplAddr.toLowerCase());
    });

    it("B6: feeManager.treasury == deployed treasury", async function () {
      const v = await feeManager.treasury();
      const ok = v.toLowerCase() === treasuryAddr.toLowerCase();
      row("B", "feeManager.treasury == treasury", ok, ok ? "" : `got ${v}`);
      expect(v.toLowerCase()).to.equal(treasuryAddr.toLowerCase());
    });

    it("B7: factory.identityRegistry == address(0) (not pre-configured)", async function () {
      const v = await factory.identityRegistry();
      const ok = v === ethers.ZeroAddress;
      row(
        "B",
        "factory.identityRegistry == 0x0 (unconfigured at deploy)",
        ok,
        ok ? "" : `got ${v}`,
      );
      expect(v).to.equal(ethers.ZeroAddress);
    });

    it("B8: factory.riskRegistry == address(0) (not pre-configured)", async function () {
      const v = await factory.riskRegistry();
      const ok = v === ethers.ZeroAddress;
      row(
        "B",
        "factory.riskRegistry == 0x0 (unconfigured at deploy)",
        ok,
        ok ? "" : `got ${v}`,
      );
      expect(v).to.equal(ethers.ZeroAddress);
    });

    it("B9: factory.loanCount == 0 at genesis", async function () {
      const v = await factory.loanCount();
      const ok = v === 0n;
      row("B", "factory.loanCount == 0 at genesis", ok, ok ? "" : `got ${v}`);
      expect(v).to.equal(0n);
    });

    it("B10: factory is NOT paused at genesis", async function () {
      const paused = await factory.paused();
      row("B", "factory is not paused at genesis", !paused);
      expect(paused).to.be.false;
    });
  });

  // ── C. Timelock coverage ───────────────────────────────────────────────────

  describe("C. Timelock coverage — every high-value setter reverts without prior schedule", function () {
    async function expectTimelocked(
      contract: any,
      funcName: string,
      args: any[],
    ) {
      const call = contract[funcName](...args);
      await expect(call).to.be.revertedWithCustomError(
        contract,
        "TimelockNotScheduled",
      );
    }

    // Factory — critical pointer setters
    it("C1: factory.setLoanImplementation — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setLoanImplementation", [dummy]);
      row("C", "factory.setLoanImplementation timelocked", true);
    });

    it("C2: factory.setFeeManager — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setFeeManager", [dummy]);
      row("C", "factory.setFeeManager timelocked", true);
    });

    it("C3: factory.setCollateralVault — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setCollateralVault", [dummy]);
      row("C", "factory.setCollateralVault timelocked", true);
    });

    it("C4: factory.setTreasury — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setTreasury", [dummy]);
      row("C", "factory.setTreasury timelocked", true);
    });

    // Factory — policy setters
    it("C5: factory.setRiskRegistry — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setRiskRegistry", [dummy]);
      row("C", "factory.setRiskRegistry timelocked", true);
    });

    it("C6: factory.setPool — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setPool", [dummy, true]);
      row("C", "factory.setPool timelocked", true);
    });

    it("C7: factory.setIdentityRegistry — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setIdentityRegistry", [dummy]);
      row("C", "factory.setIdentityRegistry timelocked", true);
    });

    it("C8: factory.setKycRequired — reverts without schedule", async function () {
      await expectTimelocked(factory, "setKycRequired", [true]);
      row("C", "factory.setKycRequired timelocked", true);
    });

    it("C9: factory.setEnforceJurisdiction — reverts without schedule", async function () {
      await expectTimelocked(factory, "setEnforceJurisdiction", [true]);
      row("C", "factory.setEnforceJurisdiction timelocked", true);
    });

    it("C10: factory.setEnforceTierCaps — reverts without schedule", async function () {
      await expectTimelocked(factory, "setEnforceTierCaps", [true]);
      row("C", "factory.setEnforceTierCaps timelocked", true);
    });

    it("C11: factory.setRequireFiatProofBeforeActivate — reverts without schedule", async function () {
      await expectTimelocked(factory, "setRequireFiatProofBeforeActivate", [
        true,
      ]);
      row("C", "factory.setRequireFiatProofBeforeActivate timelocked", true);
    });

    it("C12: factory.setSettlementAgent — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setSettlementAgent", [dummy]);
      row("C", "factory.setSettlementAgent timelocked", true);
    });

    it("C13: factory.allowCollateral — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "allowCollateral", [dummy]);
      row("C", "factory.allowCollateral timelocked", true);
    });

    it("C14: factory.setMinCollateralRatioBps — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(factory, "setMinCollateralRatioBps", [
        dummy,
        5000,
      ]);
      row("C", "factory.setMinCollateralRatioBps timelocked", true);
    });

    // FeeManager
    it("C15: feeManager.setFees — reverts without schedule", async function () {
      await expectTimelocked(feeManager, "setFees", [100, 0, 0]);
      row("C", "feeManager.setFees timelocked", true);
    });

    it("C16: feeManager.setTreasury — reverts without schedule", async function () {
      const dummy = ethers.Wallet.createRandom().address;
      await expectTimelocked(feeManager, "setTreasury", [dummy]);
      row("C", "feeManager.setTreasury timelocked", true);
    });

    // Verify immediate (non-timelocked) setters are accessible
    it("C17: factory.setJurisdictionAllowed — executes immediately (no timelock)", async function () {
      // Should NOT revert with TimelockNotScheduled
      await expect(factory.setJurisdictionAllowed(840, true)).to.emit(
        factory,
        "JurisdictionAllowedSet",
      );
      await factory.setJurisdictionAllowed(840, false); // reset
      row(
        "C",
        "factory.setJurisdictionAllowed NOT timelocked (immediate)",
        true,
      );
    });

    it("C18: factory.setTierBorrowCap — executes immediately (no timelock)", async function () {
      await expect(
        factory.setTierBorrowCap(1, ethers.parseUnits("1000", 6)),
      ).to.emit(factory, "TierBorrowCapSet");
      await factory.setTierBorrowCap(1, 0); // reset
      row("C", "factory.setTierBorrowCap NOT timelocked (immediate)", true);
    });
  });

  // ── D. E2E createLoan: vault + feeManager LOAN_ROLE wiring ────────────────

  describe("D. E2E createLoan — role wiring and fee collection", function () {
    let weth: any;
    let loanAddr: string;
    let loan: any;
    const [admin] = [] as any[];
    const PRINCIPAL = 10_000_000n; // 10 USDC (6 dec)
    const COLLATERAL = ethers.parseEther("5");

    before(async function () {
      const [deployer, , lender, borrower] = await ethers.getSigners();

      // Deploy mock collateral token
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

      // Allow WETH as collateral via timelock
      await timelockExec(factory, "allowCollateral", [await weth.getAddress()]);

      // Create a DIRECT loan
      const params = {
        fundingModel: 0, // DIRECT
        repaymentModel: 0, // BULLET
        borrower: borrower.address,
        collateralToken: await weth.getAddress(),
        collateralAmount: COLLATERAL,
        principalAmount: PRINCIPAL,
        interestRateBps: 1200,
        durationSeconds: 30 * 24 * 3600,
        gracePeriodSeconds: 7 * 24 * 3600,
        fundingDeadline: 0,
        pool: ethers.ZeroAddress,
        totalInstallments: 0,
        installmentInterval: 0,
        installmentGracePeriod: 0,
        penaltyAprBps: 0,
        defaultThresholdDays: 0,
        scheduleHash: ethers.ZeroHash,
      };
      await factory.connect(borrower).createLoan(params);
      const idx = (await factory.loanCount()) - 1n;
      loanAddr = await factory.loans(idx);
      loan = await ethers.getContractAt("UnifiedLoan", loanAddr);
    });

    it("D1: factory.isLoan == true for the new clone", async function () {
      const ok = await factory.isLoan(loanAddr);
      row("D", "factory.isLoan(loanClone) == true", ok);
      expect(ok).to.be.true;
    });

    it("D2: vault grants LOAN_ROLE to loan clone after createLoan", async function () {
      const loanRole = await vault.LOAN_ROLE();
      const ok = await vault.hasRole(loanRole, loanAddr);
      row("D", "vault: clone has LOAN_ROLE after createLoan", ok);
      expect(ok).to.be.true;
    });

    it("D3: feeManager grants LOAN_ROLE to loan clone after createLoan", async function () {
      const loanRole = await feeManager.LOAN_ROLE();
      const ok = await feeManager.hasRole(loanRole, loanAddr);
      row("D", "feeManager: clone has LOAN_ROLE after createLoan", ok);
      expect(ok).to.be.true;
    });

    it("D4: loan can fund → lock → activate → collectFee flows correctly", async function () {
      const [deployer, , lender, borrower] = await ethers.getSigners();

      // Mint USDC to lender and fund loan
      await usdc.mint(lender.address, PRINCIPAL);
      await usdc.connect(lender).approve(loanAddr, PRINCIPAL);
      await loan.connect(lender).fund(PRINCIPAL);

      // Mint collateral and lock
      await weth.mint(borrower.address, COLLATERAL);
      await weth.connect(borrower).approve(collateralVaultAddr, COLLATERAL);
      await loan.connect(borrower).lockCollateral();

      // Activate — this calls feeManager.collectFee (if origination fee > 0)
      // With originationFeeBps=0 (deploy default), collectFee is called with 0 → no-op safe
      await loan.connect(borrower).activateAndDisburse();

      const status = await loan.status();
      row("D", "E2E fund→lock→activate succeeds (fees=0)", status === 2n);
      expect(status).to.equal(2n); // ACTIVE
    });

    it("D5: fee collection works when origination fee > 0 (schedule + setFees)", async function () {
      const [deployer, , lender, borrower2] = await ethers.getSigners();

      // Set a non-zero origination fee (requires timelock)
      await timelockExec(feeManager, "setFees", [50, 0, 0]); // 50 bps origination

      // Allow same collateral (already allowed from before)
      const params = {
        fundingModel: 0,
        repaymentModel: 0,
        borrower: borrower2.address,
        collateralToken: await weth.getAddress(),
        collateralAmount: COLLATERAL,
        principalAmount: PRINCIPAL,
        interestRateBps: 1200,
        durationSeconds: 30 * 24 * 3600,
        gracePeriodSeconds: 7 * 24 * 3600,
        fundingDeadline: 0,
        pool: ethers.ZeroAddress,
        totalInstallments: 0,
        installmentInterval: 0,
        installmentGracePeriod: 0,
        penaltyAprBps: 0,
        defaultThresholdDays: 0,
        scheduleHash: ethers.ZeroHash,
      };
      await factory.connect(borrower2).createLoan(params);
      const idx = (await factory.loanCount()) - 1n;
      const loan2Addr = await factory.loans(idx);
      const loan2 = await ethers.getContractAt("UnifiedLoan", loan2Addr);

      // Fund
      await usdc.mint(lender.address, PRINCIPAL);
      await usdc.connect(lender).approve(loan2Addr, PRINCIPAL);
      await loan2.connect(lender).fund(PRINCIPAL);

      // Lock collateral
      await weth.mint(borrower2.address, COLLATERAL);
      await weth.connect(borrower2).approve(collateralVaultAddr, COLLATERAL);
      await loan2.connect(borrower2).lockCollateral();

      // Activate — origination fee should route to treasury
      const treasuryBefore = await usdc.balanceOf(treasuryAddr);
      await loan2.connect(borrower2).activateAndDisburse();
      const treasuryAfter = await usdc.balanceOf(treasuryAddr);

      const feeCollected = treasuryAfter - treasuryBefore;
      const expectedFee = (PRINCIPAL * 50n) / 10000n; // 50 bps of 10 USDC = 5000 units
      const ok = feeCollected === expectedFee;
      row(
        "D",
        `fee collection: treasury received ${feeCollected} (expected ${expectedFee})`,
        ok,
      );
      expect(feeCollected).to.equal(expectedFee);

      // Reset fees back to 0 for subsequent tests
      await timelockExec(feeManager, "setFees", [0, 0, 0]);
    });
  });

  // ── E. POOL loan — pool.LOAN_ROLE wiring ─────────────────────────────────

  describe("E. POOL loan — factory auto-grants LOAN_ROLE on pool", function () {
    let pool: any;
    let poolAddr: string;
    let poolLoanAddr: string;

    before(async function () {
      const [deployer, , , borrower] = await ethers.getSigners();

      // Deploy a pool
      const Pool = await ethers.getContractFactory("UnifiedPool");
      const partnerId = ethers.encodeBytes32String("PARITY_PARTNER");
      pool = await Pool.deploy(deployer.address, usdcAddr, partnerId);
      poolAddr = await pool.getAddress();

      // Grant factory LOAN_REGISTRAR_ROLE on the pool.
      // This is a required operational step whenever a new pool is deployed:
      // without it, factory._initAndRegister reverts when calling pool.setLoanRole().
      const loanRegistrarRole = await pool.LOAN_REGISTRAR_ROLE();
      await pool.grantRole(loanRegistrarRole, factoryAddr);

      // Whitelist pool on factory via timelock
      await timelockExec(factory, "setPool", [poolAddr, true]);
    });

    it("E1: factory.isPool == true after setPool", async function () {
      const ok = await factory.isPool(poolAddr);
      row("E", "factory.isPool == true after timelocked setPool", ok);
      expect(ok).to.be.true;
    });

    it("E2: createLoan(POOL) auto-grants LOAN_ROLE to clone on the pool", async function () {
      const [, , , borrower] = await ethers.getSigners();
      const wethAddr = await (
        await ethers.getContractAt("MockERC20", await factory.usdc())
      ).getAddress(); // reuse USDC for weth slot (pool loan test only needs wiring)

      // We need an allowed collateral — reuse the WETH token address already allowed from D
      // Find first allowed collateral by using the WETH deployed in section D
      // We'll read allowedCollateral check via a fresh token or the one already approved
      // For simplicity, create a new loan with the same WETH address (it's already allowed)
      const [, , lender, borrower2] = await ethers.getSigners();

      // Identify the WETH token address via factory — it should still be allowed from section D
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const weth = await MockERC20.deploy("WETH2", "WETH2", 18);
      const weth2Addr = await weth.getAddress();
      await timelockExec(factory, "allowCollateral", [weth2Addr]);

      const PRINCIPAL = 5_000_000n;
      const COLLATERAL = ethers.parseEther("2");

      const params = {
        fundingModel: 2, // POOL
        repaymentModel: 0, // BULLET
        borrower: borrower.address,
        collateralToken: weth2Addr,
        collateralAmount: COLLATERAL,
        principalAmount: PRINCIPAL,
        interestRateBps: 800,
        durationSeconds: 30 * 24 * 3600,
        gracePeriodSeconds: 7 * 24 * 3600,
        fundingDeadline: 0,
        pool: poolAddr,
        totalInstallments: 0,
        installmentInterval: 0,
        installmentGracePeriod: 0,
        penaltyAprBps: 0,
        defaultThresholdDays: 0,
        scheduleHash: ethers.ZeroHash,
      };

      await factory.connect(borrower).createLoan(params);
      const idx = (await factory.loanCount()) - 1n;
      poolLoanAddr = await factory.loans(idx);

      const loanRole = await pool.LOAN_ROLE();
      const ok = await pool.hasRole(loanRole, poolLoanAddr);
      row("E", "pool: POOL loan clone has LOAN_ROLE after createLoan", ok);
      expect(ok).to.be.true;
    });
  });

  // ── F. Generate parity report ─────────────────────────────────────────────

  after(function () {
    // Console summary
    console.log("\n\n========================================");
    console.log("   Deployment Parity Report");
    console.log("========================================");

    const sections = ["A", "B", "C", "D", "E"];
    const sectionTitles: Record<string, string> = {
      A: "Role grants",
      B: "Contract pointer wiring",
      C: "Timelock coverage",
      D: "E2E createLoan (fee + vault wiring)",
      E: "POOL loan LOAN_ROLE wiring",
    };

    let totalPass = 0,
      totalFail = 0;
    const lines: string[] = [
      "# Unified — Deployment Parity Report",
      `Generated: ${new Date().toISOString()}`,
      `Deployed by: scripts/deploy.ts (not test fixtures)`,
      "",
    ];

    for (const s of sections) {
      const sRows = report.filter((r) => r.section === s);
      if (sRows.length === 0) continue;
      const sPass = sRows.filter((r) => r.status === "PASS").length;
      const sFail = sRows.filter((r) => r.status === "FAIL").length;
      totalPass += sPass;
      totalFail += sFail;

      const icon = sFail === 0 ? "✓" : "✗";
      console.log(`\n[${s}] ${sectionTitles[s]} (${sPass}/${sRows.length})`);
      lines.push(`## ${s}. ${sectionTitles[s]}`);
      lines.push("");
      lines.push("| # | Check | Status |");
      lines.push("|---|---|---|");

      for (const r of sRows) {
        const icon2 = r.status === "PASS" ? "✓" : "✗";
        const detail = r.detail ? ` — ${r.detail}` : "";
        console.log(`  ${icon2} ${r.check}${detail}`);
        lines.push(`| ${icon2} | ${r.check}${detail} | ${r.status} |`);
      }
      lines.push("");
    }

    // Missing invariants section
    const failures = report.filter((r) => r.status === "FAIL");
    lines.push("## Missing invariants / Findings");
    lines.push("");
    if (failures.length === 0) {
      lines.push("None — all checks passed.");
    } else {
      for (const f of failures) {
        lines.push(
          `- [FAIL] [${f.section}] ${f.check}${
            f.detail ? `: ${f.detail}` : ""
          }`,
        );
      }
    }
    lines.push("");

    // Timelock coverage list
    lines.push("## Timelocked setters (full list)");
    lines.push("");
    lines.push("### UnifiedLoanFactory");
    const factoryTimelocked = [
      "setLoanImplementation(address)",
      "setFeeManager(address)",
      "setCollateralVault(address)",
      "setTreasury(address)",
      "setRiskRegistry(address)",
      "setPool(address,bool)",
      "setIdentityRegistry(address)",
      "setKycRequired(bool)",
      "setEnforceJurisdiction(bool)",
      "setEnforceTierCaps(bool)",
      "setRequireFiatProofBeforeActivate(bool)",
      "setSettlementAgent(address)",
      "allowCollateral(address)",
      "setAllowedCollateral(address,bool)",
      "setMinCollateralRatioBps(address,uint256)",
    ];
    for (const fn of factoryTimelocked) lines.push(`- \`${fn}\``);
    lines.push("");
    lines.push("### UnifiedFeeManager");
    lines.push("- `setFees(uint256,uint256,uint256)`");
    lines.push("- `setTreasury(address)`");
    lines.push("");
    lines.push("### Immediate (no timelock)");
    lines.push("- `factory.setJurisdictionAllowed(uint256,bool)`");
    lines.push("- `factory.setTierBorrowCap(uint8,uint256)`");
    lines.push("- `identityRegistry.setIdentity(...)` (KYC_MANAGER_ROLE)");
    lines.push("- `riskRegistry.setRisk(...)` (RISK_ORACLE_ROLE)");
    lines.push("- `pause()` / `unpause()` on factory, pool, loan");
    lines.push("");

    console.log(`\nTotal: ${totalPass} passed, ${totalFail} failed`);
    if (totalFail > 0) {
      console.log("DEPLOYMENT PARITY: FAIL — see report for details");
    } else {
      console.log("DEPLOYMENT PARITY: PASS");
    }
    console.log("========================================\n");

    // Write report file
    const reportDir = path.resolve(__dirname, "../docs");
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, "deployment-parity-report.md");
    fs.writeFileSync(reportPath, lines.join("\n"), "utf8");
    console.log(`Report written to: ${reportPath}`);
  });
});
